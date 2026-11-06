// Gotify REST and WebSocket client. Shared by the shell, the preferences and
// the messages window, so it must not import Gtk, St or anything shell-only.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Soup.Session.prototype, 'websocket_connect_async');

const PAGE_SIZE = 200; // The server rejects anything above this.
const MAX_CATCH_UP_MESSAGES = 1000;
const MAX_STREAM_PAYLOAD = 4 * 1024 * 1024;
const WS_KEEPALIVE_SECONDS = 30;
const WS_PONG_TIMEOUT_SECONDS = 15;

export class GotifyError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'GotifyError';
        this.status = status;
    }

    get isAuthError() {
        return this.status === 401 || this.status === 403;
    }
}

/**
 * @param {string} value - URL as typed by the user
 * @returns {string} URL with scheme and without trailing slashes, '' if blank
 */
export function normalizeServerUrl(value) {
    const url = value.trim().replace(/\/+$/, '');
    if (!url)
        return '';
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

function describeStatus(status, reason) {
    if (status === 401 || status === 403)
        return 'Token rejected. A client token is required, not an app token.';
    return `Server responded with ${status} ${reason ?? ''}`.trim();
}

class GotifyStream {
    constructor(connection, {onMessage, onClosed}) {
        this._connection = connection;
        connection.max_incoming_payload_size = MAX_STREAM_PAYLOAD;
        connection.keepalive_interval = WS_KEEPALIVE_SECONDS;
        // Detects connections that died silently, e.g. across a suspend.
        connection.keepalive_pong_timeout = WS_PONG_TIMEOUT_SECONDS;

        connection.connect('message', (_conn, type, bytes) => {
            if (type !== Soup.WebsocketDataType.TEXT)
                return;
            try {
                onMessage(JSON.parse(new TextDecoder().decode(bytes.toArray())));
            } catch (e) {
                console.warn(`Gotify: ignoring malformed stream message: ${e.message}`);
            }
        });
        connection.connect('closed', () => onClosed());
    }

    close() {
        if (this._connection.get_state() === Soup.WebsocketState.OPEN)
            this._connection.close(Soup.WebsocketCloseCode.NORMAL, null);
    }
}

export class GotifyClient {
    constructor(serverUrl, token) {
        this._base = normalizeServerUrl(serverUrl);
        this._token = token;
        this._session = new Soup.Session({
            user_agent: 'gnome-shell-extension-gotify',
            timeout: 30,
        });
    }

    _message(method, path) {
        let message = null;
        try {
            message = Soup.Message.new(method, `${this._base}${path}`);
        } catch {
            // Reported below; older bindings return null instead.
        }
        if (!message)
            throw new GotifyError(`Invalid server URL: ${this._base}`);
        message.get_request_headers().append('X-Gotify-Key', this._token);
        return message;
    }

    async _request(method, path, cancellable = null) {
        const message = this._message(method, path);
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new GotifyError(`Server unreachable: ${e.message}`);
        }
        const status = message.get_status();
        if (status < 200 || status >= 300)
            throw new GotifyError(describeStatus(status, message.get_reason_phrase()), status);
        return bytes;
    }

    async _requestJson(method, path, cancellable) {
        const bytes = await this._request(method, path, cancellable);
        try {
            return JSON.parse(new TextDecoder().decode(bytes.toArray()));
        } catch {
            throw new GotifyError('The response is not Gotify JSON. Is the server URL correct?');
        }
    }

    getVersion(cancellable = null) {
        return this._requestJson('GET', '/version', cancellable);
    }

    getApplications(cancellable = null) {
        return this._requestJson('GET', '/application', cancellable);
    }

    /**
     * @param {object} [options]
     * @param {number} [options.limit] - page size, at most 200
     * @param {number} [options.since] - only return IDs below this; 0 for newest
     * @param {number|null} [options.appId] - restrict to one application
     * @param {Gio.Cancellable} [options.cancellable]
     * @returns {Promise<{messages: object[], paging: object}>} newest first
     */
    getMessages({limit = 100, since = 0, appId = null, cancellable = null} = {}) {
        const prefix = appId === null ? '' : `/application/${appId}`;
        return this._requestJson('GET',
            `${prefix}/message?limit=${limit}&since=${since}`, cancellable);
    }

    /**
     * @param {number} afterId - exclusive lower bound
     * @param {Gio.Cancellable} [cancellable]
     * @returns {Promise<object[]>} all messages above afterId, newest first
     */
    async getMessagesAfter(afterId, cancellable = null) {
        const result = [];
        let since = 0;
        while (result.length < MAX_CATCH_UP_MESSAGES) {
            // eslint-disable-next-line no-await-in-loop
            const {messages, paging} = await this.getMessages({limit: PAGE_SIZE, since, cancellable});
            for (const message of messages) {
                if (message.id <= afterId)
                    return result;
                result.push(message);
            }
            if (!paging.next)
                break;
            since = paging.since;
        }
        return result;
    }

    async deleteMessage(id, cancellable = null) {
        await this._request('DELETE', `/message/${id}`, cancellable);
    }

    /**
     * @param {number|null} [appId] - restrict to one application
     * @param {Gio.Cancellable} [cancellable]
     */
    async deleteMessages(appId = null, cancellable = null) {
        const prefix = appId === null ? '' : `/application/${appId}`;
        await this._request('DELETE', `${prefix}/message`, cancellable);
    }

    /**
     * @param {string} path - server-relative path, e.g. an application's image
     * @param {Gio.Cancellable} [cancellable]
     * @returns {Promise<GLib.Bytes>}
     */
    getBytes(path, cancellable = null) {
        return this._request('GET', `/${path.replace(/^\/+/, '')}`, cancellable);
    }

    /**
     * @param {object} handlers
     * @param {function(object): void} handlers.onMessage
     * @param {function(): void} handlers.onClosed
     * @param {Gio.Cancellable} [cancellable]
     * @returns {Promise<GotifyStream>}
     */
    async openStream(handlers, cancellable = null) {
        const message = this._message('GET', '/stream');
        try {
            const connection = await this._session.websocket_connect_async(
                message, null, null, GLib.PRIORITY_DEFAULT, cancellable);
            return new GotifyStream(connection, handlers);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            const status = message.get_status();
            if (status === 401 || status === 403)
                throw new GotifyError(describeStatus(status), status);
            throw new GotifyError(`Stream unreachable: ${e.message}`, status);
        }
    }

    destroy() {
        this._session.abort();
    }
}
