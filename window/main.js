#!@GJS@ -m
// The messages window. Runs as a separate process, see openMessages() in
// extension.js. Gio.Application uniqueness keeps it to a single instance.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {GotifyClient} from '../lib/client.js';
import {UUID, WINDOW_APP_ID} from '../lib/constants.js';
import {lookupToken} from '../lib/secret.js';

const PAGE_SIZE = 100;
const STREAM_RETRY_SECONDS = 10;
const FALLBACK_ICON = 'mail-unread-symbolic';
const SCHEMA_ID = 'org.gnome.shell.extensions.gotify';
const EXTENSION_DIR = GLib.path_get_dirname(GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]));

const CSS = `
.gotify-message { padding: 10px 12px; }
.gotify-message.new { box-shadow: inset 3px 0 @accent_bg_color; }
.gotify-priority-high { color: @error_color; font-weight: bold; }
`;

function loadSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([EXTENSION_DIR, 'schemas']),
        Gio.SettingsSchemaSource.get_default(), false);
    return new Gio.Settings({settings_schema: source.lookup(SCHEMA_ID, false)});
}

function formatDate(iso) {
    const date = iso ? GLib.DateTime.new_from_iso8601(iso, null)?.to_local() : null;
    if (!date)
        return '';
    const today = GLib.DateTime.new_now_local();
    const isToday = date.get_ymd().join() === today.get_ymd().join();
    return date.format(isToday ? '%H:%M' : '%d.%m.%Y %H:%M');
}

// Message content comes from arbitrary senders: every label here must stay
// plain text, never Pango markup.
function plainLabel(text, props = {}) {
    return new Gtk.Label({label: text, use_markup: false, xalign: 0, ...props});
}

const CategoryRow = GObject.registerClass(
class CategoryRow extends Gtk.ListBoxRow {
    _init(appId, name) {
        super._init();
        this.appId = appId;
        this.categoryName = name;

        const box = new Gtk.Box({spacing: 10});
        this._image = new Gtk.Image({icon_name: FALLBACK_ICON, pixel_size: 24});
        this._badge = plainLabel('', {visible: false, css_classes: ['caption', 'accent']});
        box.append(this._image);
        box.append(plainLabel(name, {hexpand: true, ellipsize: Pango.EllipsizeMode.END}));
        box.append(this._badge);
        this.set_child(box);
    }

    setIcon(paintable) {
        this._image.set_from_paintable(paintable);
    }

    setNewCount(count) {
        this._badge.label = `${count} new`;
        this._badge.visible = count > 0;
    }
});

const MessageRow = GObject.registerClass(
class MessageRow extends Gtk.ListBoxRow {
    _init(message, categoryName, isNew, onDelete) {
        super._init({activatable: false, selectable: false, css_classes: ['gotify-message']});
        this.messageId = message.id;
        if (isNew)
            this.add_css_class('new');

        const header = new Gtk.Box({spacing: 8});
        header.append(plainLabel(categoryName, {css_classes: ['caption', 'dim-label']}));
        header.append(plainLabel(formatDate(message.date), {
            hexpand: true,
            css_classes: ['caption', 'dim-label'],
        }));
        if (message.priority >= 8) {
            header.append(plainLabel(`Priority ${message.priority}`, {
                css_classes: ['caption', 'gotify-priority-high'],
            }));
        }
        const deleteButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Delete Message',
            css_classes: ['flat', 'circular'],
        });
        deleteButton.connect('clicked', () => onDelete(this));
        header.append(deleteButton);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        box.append(header);
        const wrap = {wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: true};
        if (message.title)
            box.append(plainLabel(message.title, {...wrap, css_classes: ['heading']}));
        box.append(plainLabel(message.message ?? '', wrap));
        this.set_child(box);
    }
});

const MessagesWindow = GObject.registerClass(
class MessagesWindow extends Adw.ApplicationWindow {
    _init(params) {
        super._init({title: 'Gotify', default_width: 960, default_height: 680, ...params});
        this._settings = loadSettings();
        this._client = null;
        this._stream = null;
        this._streamRetryId = 0;
        this._apps = new Map();
        this._icons = new Map();
        this._newIds = new Set();
        this._maxId = 0;
        this._appId = null; // null selects "all messages".
        this._nextSince = 0;
        this._reloadGeneration = 0;
        this._listGeneration = 0;
        this._loadingMore = false;
        this._closed = false;
        this._cancellable = new Gio.Cancellable();

        this._buildUi();

        this.connect('notify::is-active', () => {
            if (this.is_active)
                this._markRead();
        });
        this.connect('close-request', () => {
            this._closed = true;
            this._cancellable.cancel();
            this._cancelStreamRetry();
            this._stream?.close();
            return false;
        });

        this._reload().catch(e => this._showError(e));
    }

    _buildUi() {
        this._categoryList = new Gtk.ListBox({css_classes: ['navigation-sidebar']});
        this._categoryList.connect('row-selected', (_list, row) => {
            if (row)
                this._selectCategory(row);
        });

        const sidebarHeader = new Adw.HeaderBar();
        const settingsButton = new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: 'Settings',
        });
        settingsButton.connect('clicked', () => this._openPreferences());
        sidebarHeader.pack_end(settingsButton);

        const sidebarContent = new Adw.ToolbarView({
            content: new Gtk.ScrolledWindow({
                child: this._categoryList,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
            }),
        });
        sidebarContent.add_top_bar(sidebarHeader);

        this._messageList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            valign: Gtk.Align.START,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            css_classes: ['boxed-list'],
        });
        this._scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: new Adw.Clamp({maximum_size: 860, child: this._messageList}),
        });
        this._scroller.connect('edge-reached', (_scroller, position) => {
            if (position === Gtk.PositionType.BOTTOM)
                this._loadMore().catch(e => this._toast(e.message));
        });

        this._statusPage = new Adw.StatusPage();
        this._statusButton = new Gtk.Button({
            label: 'Open Settings',
            halign: Gtk.Align.CENTER,
            css_classes: ['pill', 'suggested-action'],
        });
        this._statusButton.connect('clicked', () => this._openPreferences());
        this._statusPage.set_child(this._statusButton);

        this._stack = new Gtk.Stack();
        this._stack.add_named(this._scroller, 'messages');
        this._stack.add_named(this._statusPage, 'status');
        this._stack.add_named(new Adw.Spinner(), 'loading');

        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh',
        });
        refreshButton.connect('clicked', () => this._reload().catch(e => this._showError(e)));
        this._deleteAllButton = new Gtk.Button({
            icon_name: 'edit-clear-all-symbolic',
            tooltip_text: 'Delete All Messages in This View',
        });
        this._deleteAllButton.connect('clicked',
            () => this._confirmDeleteAll().catch(e => this._toast(e.message)));

        const contentHeader = new Adw.HeaderBar();
        contentHeader.pack_start(refreshButton);
        contentHeader.pack_end(this._deleteAllButton);

        this._toasts = new Adw.ToastOverlay({child: this._stack});
        const content = new Adw.ToolbarView({content: this._toasts});
        content.add_top_bar(contentHeader);

        this._contentPage = new Adw.NavigationPage({title: 'All Messages', child: content});
        this._split = new Adw.NavigationSplitView({
            sidebar: new Adw.NavigationPage({title: 'Categories', child: sidebarContent}),
            content: this._contentPage,
        });
        this.set_content(this._split);

        const breakpoint = new Adw.Breakpoint({
            condition: Adw.BreakpointCondition.parse('max-width: 600sp'),
        });
        breakpoint.add_setter(this._split, 'collapsed', true);
        this.add_breakpoint(breakpoint);
    }

    _openPreferences() {
        Gio.Subprocess.new(['gnome-extensions', 'prefs', UUID], Gio.SubprocessFlags.NONE);
    }

    _showStatus(icon, title, description, withSettingsButton) {
        this._statusPage.icon_name = icon;
        this._statusPage.title = title;
        this._statusPage.description = description
            ? GLib.markup_escape_text(description, -1) : null;
        this._statusButton.visible = withSettingsButton;
        this._stack.visible_child_name = 'status';
    }

    _showError(error) {
        if (this._closed || error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        console.warn(`Gotify: ${error.message}`);
        this._showStatus('network-error-symbolic', 'Loading Failed', error.message, true);
    }

    _toast(text) {
        this._toasts.add_toast(new Adw.Toast({title: GLib.markup_escape_text(text, -1)}));
    }

    async _reload() {
        const generation = ++this._reloadGeneration;
        this._stack.visible_child_name = 'loading';

        const url = this._settings.get_string('server-url');
        const token = await lookupToken();
        if (!url || !token) {
            this._showStatus('dialog-password-symbolic', 'Not Set Up Yet',
                'Enter the server URL and client token in the settings.', true);
            return;
        }

        this._cancelStreamRetry();
        this._stream?.close();
        this._stream = null;
        this._client?.destroy();
        const client = this._client = new GotifyClient(url, token);

        const [apps, {messages: [newest]}] = await Promise.all([
            client.getApplications(this._cancellable),
            client.getMessages({limit: 1, cancellable: this._cancellable}),
        ]);
        const lastRead = this._settings.get_int64('last-read-id');
        const fresh = lastRead > 0
            ? await client.getMessagesAfter(lastRead, this._cancellable) : [];
        if (generation !== this._reloadGeneration)
            return;

        this._maxId = newest?.id ?? 0;
        this._newIds = new Set(fresh.map(message => message.id));
        this._apps = new Map(apps.map(app => [app.id, app]));
        this._rebuildCategories(fresh);
        await this._loadMessages();
        if (generation !== this._reloadGeneration)
            return;

        this._markRead();
        this._startStream().catch(() => this._scheduleStreamRetry());
    }

    _rebuildCategories(freshMessages) {
        const selectedAppId = this._appId;
        this._suppressSelection = true;
        this._categoryList.remove_all();

        const counts = new Map();
        for (const {appid} of freshMessages)
            counts.set(appid, (counts.get(appid) ?? 0) + 1);

        const allRow = new CategoryRow(null, 'All Messages');
        allRow.setNewCount(freshMessages.length);
        this._categoryList.append(allRow);

        let selectedRow = allRow;
        const apps = [...this._apps.values()]
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const app of apps) {
            const row = new CategoryRow(app.id, app.name);
            row.setNewCount(counts.get(app.id) ?? 0);
            this._categoryList.append(row);
            this._loadIcon(app, row).catch(() => {}); // The fallback icon stays.
            if (app.id === selectedAppId)
                selectedRow = row;
        }

        this._appId = selectedRow.appId;
        this._categoryList.select_row(selectedRow);
        this._suppressSelection = false;
        this._contentPage.title = selectedRow.categoryName;
    }

    async _loadIcon(app, row) {
        let texture = this._icons.get(app.id);
        if (!texture && app.image) {
            const bytes = await this._client.getBytes(app.image, this._cancellable);
            texture = Gdk.Texture.new_from_bytes(bytes);
            this._icons.set(app.id, texture);
        }
        if (texture)
            row.setIcon(texture);
    }

    _selectCategory(row) {
        if (this._suppressSelection)
            return;
        row.setNewCount(0);
        this._split.show_content = true;
        if (row.appId === this._appId)
            return;
        this._appId = row.appId;
        this._contentPage.title = row.categoryName;
        this._stack.visible_child_name = 'loading';
        this._loadMessages().catch(e => this._showError(e));
    }

    _categoryName(appId) {
        return this._apps.get(appId)?.name ?? 'Unknown';
    }

    _createRow(message) {
        return new MessageRow(message, this._categoryName(message.appid),
            this._newIds.has(message.id), row => {
                this._deleteRow(row).catch(e => this._toast(e.message));
            });
    }

    async _loadMessages() {
        const generation = ++this._listGeneration;
        const {messages, paging} = await this._client.getMessages({
            limit: PAGE_SIZE,
            appId: this._appId,
            cancellable: this._cancellable,
        });
        if (generation !== this._listGeneration)
            return;

        this._messageList.remove_all();
        messages.forEach(message => this._messageList.append(this._createRow(message)));
        this._nextSince = paging.next ? paging.since : 0;
        this._syncEmptyState();
        this._scroller.vadjustment.value = 0;
    }

    async _loadMore() {
        if (!this._nextSince || this._loadingMore)
            return;
        this._loadingMore = true;
        const generation = this._listGeneration;
        try {
            const {messages, paging} = await this._client.getMessages({
                limit: PAGE_SIZE,
                since: this._nextSince,
                appId: this._appId,
                cancellable: this._cancellable,
            });
            if (generation !== this._listGeneration)
                return;
            messages.forEach(message => this._messageList.append(this._createRow(message)));
            this._nextSince = paging.next ? paging.since : 0;
        } finally {
            this._loadingMore = false;
        }
    }

    _syncEmptyState() {
        const isEmpty = this._messageList.get_row_at_index(0) === null;
        this._deleteAllButton.sensitive = !isEmpty;
        if (isEmpty)
            this._showStatus('mail-read-symbolic', 'No Messages', null, false);
        else
            this._stack.visible_child_name = 'messages';
    }

    async _deleteRow(row) {
        await this._client.deleteMessage(row.messageId, this._cancellable);
        this._messageList.remove(row);
        this._syncEmptyState();
    }

    async _confirmDeleteAll() {
        const scope = this._appId === null
            ? 'All messages in all categories'
            : `All messages in “${this._categoryName(this._appId)}”`;
        const dialog = new Adw.AlertDialog({
            heading: 'Delete Messages?',
            body: `${scope} will be permanently deleted from the server.`,
            default_response: 'cancel',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);

        const response = await new Promise(resolve => {
            dialog.connect('response', (_dialog, id) => resolve(id));
            dialog.present(this);
        });
        if (response !== 'delete')
            return;

        await this._client.deleteMessages(this._appId, this._cancellable);
        await this._loadMessages();
    }

    /** Opening the window counts as reading everything on the server. */
    _markRead() {
        if (this._maxId > this._settings.get_int64('last-read-id'))
            this._settings.set_int64('last-read-id', this._maxId);
    }

    async _startStream() {
        const client = this._client;
        const stream = await client.openStream({
            onMessage: message => this._onStreamMessage(message),
            onClosed: () => {
                if (client === this._client)
                    this._scheduleStreamRetry();
            },
        }, this._cancellable);
        if (this._closed || client !== this._client)
            stream.close();
        else
            this._stream = stream;
    }

    _cancelStreamRetry() {
        if (this._streamRetryId)
            GLib.source_remove(this._streamRetryId);
        this._streamRetryId = 0;
    }

    _scheduleStreamRetry() {
        if (this._closed || this._streamRetryId)
            return;
        this._stream = null;
        this._streamRetryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STREAM_RETRY_SECONDS, () => {
            this._streamRetryId = 0;
            this._startStream().catch(() => this._scheduleStreamRetry());
            return GLib.SOURCE_REMOVE;
        });
    }

    _onStreamMessage(message) {
        if (!this._apps.has(message.appid)) {
            // A category that appeared after loading: reloading covers this message too.
            this._reload().catch(e => this._showError(e));
            return;
        }

        this._maxId = Math.max(this._maxId, message.id);
        if (this.is_active)
            this._markRead();
        else
            this._newIds.add(message.id);

        if (this._appId === null || this._appId === message.appid) {
            this._messageList.prepend(this._createRow(message));
            this._syncEmptyState();
        }
    }
});

const GotifyApplication = GObject.registerClass(
class GotifyApplication extends Adw.Application {
    vfunc_startup() {
        super.vfunc_startup();
        const provider = new Gtk.CssProvider();
        provider.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    vfunc_activate() {
        (this.active_window ?? new MessagesWindow({application: this})).present();
    }
});

await new GotifyApplication({application_id: WINDOW_APP_ID}).runAsync([]);
