// Background connection: keeps the stream open, tracks unread messages and
// catches up after every (re)connect. Runs inside the shell process.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {GotifyClient} from './client.js';
import {lookupToken} from './secret.js';

const MAX_RETRY_SECONDS = 60;

export const State = Object.freeze({
    STOPPED: 'stopped',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RETRYING: 'retrying',
    UNCONFIGURED: 'unconfigured',
    AUTH_FAILED: 'auth-failed',
});

export const GotifyService = GObject.registerClass({
    Signals: {
        'state-changed': {},
        'unread-changed': {},
        'new-messages': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class GotifyService extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._state = State.STOPPED;
        this._detail = '';
        this._unread = new Set();
        this._apps = new Map();
        this._generation = 0;
        this._retryAttempt = 0;
        this._retryId = 0;
        this._cancellable = null;
        this._stream = null;
        this._client = null;

        this._settingsIds = [
            settings.connect('changed::last-read-id', () => this._pruneUnread()),
            settings.connect('changed::server-url', () => this._restart()),
            settings.connect('changed::token-revision', () => this._restart()),
        ];
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkId = this._networkMonitor.connect('network-changed',
            (_monitor, available) => {
                if (available && this._state === State.RETRYING)
                    this._restart();
            });
    }

    get state() {
        return this._state;
    }

    /** Human readable reason for the current state, if there is one. */
    get detail() {
        return this._detail;
    }

    get unreadCount() {
        return this._unread.size;
    }

    get running() {
        return this._state !== State.STOPPED;
    }

    appName(appId) {
        return this._apps.get(appId)?.name ?? 'Gotify';
    }

    start() {
        if (this.running)
            return;
        this._retryAttempt = 0;
        this._connect().catch(e => logError(e, 'Gotify'));
    }

    stop() {
        this._teardown();
        this._unread.clear();
        this.emit('unread-changed');
        this._setState(State.STOPPED);
    }

    markAllRead() {
        const newest = Math.max(0, ...this._unread);
        if (newest > this._lastRead)
            this._settings.set_int64('last-read-id', newest);
    }

    destroy() {
        this._teardown();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._networkMonitor.disconnect(this._networkId);
    }

    get _lastRead() {
        return this._settings.get_int64('last-read-id');
    }

    get _lastSeen() {
        return this._settings.get_int64('last-seen-id');
    }

    _setState(state, detail = '') {
        if (this._state === state && this._detail === detail)
            return;
        this._state = state;
        this._detail = detail;
        this.emit('state-changed');
    }

    _restart() {
        if (!this.running)
            return;
        this._teardown();
        this._retryAttempt = 0;
        this._connect().catch(e => logError(e, 'Gotify'));
    }

    _teardown() {
        this._generation++;
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._stream?.close();
        this._stream = null;
        this._client?.destroy();
        this._client = null;
    }

    async _connect() {
        const generation = ++this._generation;
        const cancellable = this._cancellable = new Gio.Cancellable();
        this._setState(State.CONNECTING);

        try {
            const url = this._settings.get_string('server-url');
            const token = await lookupToken();
            if (generation !== this._generation)
                return;
            if (!url || !token) {
                this._setState(State.UNCONFIGURED, 'Server URL or token missing');
                return;
            }

            const client = this._client = new GotifyClient(url, token);

            // Open the stream before catching up so that nothing can fall into
            // the gap. Whatever it delivers meanwhile waits in `buffered`.
            let buffered = [];
            const stream = await client.openStream({
                onMessage: message => {
                    if (generation !== this._generation)
                        return;
                    if (buffered)
                        buffered.push(message);
                    else
                        this._onStreamMessage(message, generation).catch(e => logError(e, 'Gotify'));
                },
                onClosed: () => {
                    if (generation === this._generation)
                        this._scheduleRetry('Connection lost');
                },
            }, cancellable);
            if (generation !== this._generation) {
                stream.close();
                return;
            }
            this._stream = stream;

            await this._refreshApps();
            const missed = await this._catchUp(cancellable);
            if (generation !== this._generation)
                return;

            const known = new Set(missed.map(message => message.id));
            this._ingest([...missed, ...buffered.filter(message => !known.has(message.id))]);
            buffered = null;

            this._retryAttempt = 0;
            this._setState(State.CONNECTED);
        } catch (e) {
            if (generation !== this._generation)
                return;
            if (e.isAuthError) {
                this._teardown();
                this._setState(State.AUTH_FAILED, e.message);
            } else {
                this._scheduleRetry(e.message);
            }
        }
    }

    _scheduleRetry(reason) {
        this._teardown();
        const delay = Math.min(MAX_RETRY_SECONDS, 2 ** ++this._retryAttempt);
        this._setState(State.RETRYING, reason);
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryId = 0;
            this._connect().catch(e => logError(e, 'Gotify'));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshApps() {
        const apps = await this._client.getApplications(this._cancellable);
        this._apps = new Map(apps.map(app => [app.id, app]));
    }

    async _onStreamMessage(message, generation) {
        if (!this._apps.has(message.appid)) {
            try {
                await this._refreshApps();
            } catch {
                // Only the category name is affected; appName() has a fallback.
            }
            if (generation !== this._generation)
                return;
        }
        this._ingest([message]);
    }

    /**
     * Reconciles the unread set with the server.
     *
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<object[]>} messages not processed before, oldest first
     */
    async _catchUp(cancellable) {
        const {messages: [newest]} = await this._client.getMessages({limit: 1, cancellable});
        if (!newest) {
            this._unread.clear();
            this.emit('unread-changed');
            return [];
        }

        // Nothing was ever recorded: start from "now" so that the backlog of an
        // existing server doesn't show up as new.
        if (this._lastRead === 0 && this._lastSeen === 0) {
            this._settings.set_int64('last-read-id', newest.id);
            this._settings.set_int64('last-seen-id', newest.id);
            return [];
        }

        // Lower than what we recorded means messages were deleted or the server
        // was reset. IDs of a reset server start over and would stay hidden.
        if (newest.id < this._lastRead)
            this._settings.set_int64('last-read-id', newest.id);
        if (newest.id < this._lastSeen)
            this._settings.set_int64('last-seen-id', newest.id);

        const lastRead = this._lastRead;
        const lastHandled = Math.max(lastRead, this._lastSeen);
        const messages = await this._client.getMessagesAfter(lastRead, cancellable);

        this._unread = new Set(messages.map(message => message.id));
        this.emit('unread-changed');
        return messages.filter(message => message.id > lastHandled).reverse();
    }

    _ingest(messages) {
        if (messages.length === 0)
            return;

        const lastRead = this._lastRead;
        for (const {id} of messages) {
            if (id > lastRead)
                this._unread.add(id);
        }
        const newest = Math.max(...messages.map(message => message.id));
        if (newest > this._lastSeen)
            this._settings.set_int64('last-seen-id', newest);

        this.emit('unread-changed');
        this.emit('new-messages', messages);
    }

    _pruneUnread() {
        const lastRead = this._lastRead;
        const unread = [...this._unread].filter(id => id > lastRead);
        if (unread.length === this._unread.size)
            return;
        this._unread = new Set(unread);
        this.emit('unread-changed');
    }
});
