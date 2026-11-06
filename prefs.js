import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {GotifyClient, normalizeServerUrl} from './lib/client.js';
import {clearToken, lookupToken, storeToken} from './lib/secret.js';

const DELIVERY_MODES = ['badge', 'notifications'];

function isInsecure(url) {
    return url.startsWith('http://') &&
        !/^http:\/\/(localhost|127\.|\[::1\])/.test(url);
}

export default class GotifyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._storedToken = '';
        this._cancellable = new Gio.Cancellable();
        this._categoryRows = [];

        const page = new Adw.PreferencesPage({
            title: 'Gotify',
            icon_name: 'preferences-system-symbolic',
        });
        page.add(this._buildConnectionGroup());
        page.add(this._buildBehaviorGroup());
        page.add(this._buildCategoriesGroup());
        window.add(page);

        // Closing the window must not lose what was typed.
        window.connect('close-request', () => {
            this._cancellable.cancel();
            this._saveConnection().catch(e => logError(e, 'Gotify'));
            return false;
        });

        this._loadStoredToken().catch(e => this._showStatus(
            `Keyring unavailable: ${e.message}`));
    }

    _buildConnectionGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Connection',
            description: 'Create a client token under “Clients” in the Gotify web interface. It is stored in the GNOME keyring.',
        });

        this._urlRow = new Adw.EntryRow({
            title: 'Server URL',
            text: this._settings.get_string('server-url'),
            input_purpose: Gtk.InputPurpose.URL,
        });
        this._tokenRow = new Adw.PasswordEntryRow({title: 'Client Token'});
        group.add(this._urlRow);
        group.add(this._tokenRow);

        this._statusRow = new Adw.ActionRow({
            title: 'Not tested yet',
            use_markup: false,
            title_lines: 0,
        });
        const button = new Gtk.Button({
            label: 'Save and Test',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        button.connect('clicked', () => {
            this._saveAndTest().catch(e => this._showStatus(e.message));
        });
        this._statusRow.add_suffix(button);
        group.add(this._statusRow);
        return group;
    }

    _buildBehaviorGroup() {
        const group = new Adw.PreferencesGroup({title: 'Behavior'});

        const modeRow = new Adw.ComboRow({
            title: 'On New Messages',
            subtitle: 'The panel counter goes up either way.',
            model: Gtk.StringList.new(['Counter Only', 'Notifications']),
            selected: DELIVERY_MODES.indexOf(this._settings.get_string('delivery-mode')),
        });
        modeRow.connect('notify::selected', () => {
            this._settings.set_string('delivery-mode', DELIVERY_MODES[modeRow.selected]);
        });
        group.add(modeRow);

        const autostartRow = new Adw.SwitchRow({
            title: 'Autostart',
            subtitle: 'Connect at login and listen for new messages. Without autostart, messages are only fetched when you open the window with a left click.',
        });
        this._settings.bind('autostart', autostartRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(autostartRow);
        return group;
    }

    _buildCategoriesGroup() {
        this._categoriesGroup = new Adw.PreferencesGroup({
            title: 'Categories',
            description: 'The applications that send messages to this server.',
        });
        return this._categoriesGroup;
    }

    async _loadStoredToken() {
        this._storedToken = await lookupToken() ?? '';
        this._tokenRow.text = this._storedToken;
        if (this._urlRow.text && this._storedToken)
            await this._saveAndTest();
    }

    async _saveConnection() {
        const url = normalizeServerUrl(this._urlRow.text);
        const token = this._tokenRow.text.trim();
        const urlChanged = url !== this._settings.get_string('server-url');
        const tokenChanged = token !== this._storedToken;

        if (urlChanged) {
            // IDs of another server say nothing about this one.
            this._settings.set_int64('last-read-id', 0);
            this._settings.set_int64('last-seen-id', 0);
            this._settings.set_string('server-url', url);
        }
        if (tokenChanged) {
            this._storedToken = token;
            await (token ? storeToken(token) : clearToken());
            this._settings.set_uint('token-revision',
                this._settings.get_uint('token-revision') + 1);
        }
    }

    async _saveAndTest() {
        this._showStatus('Testing connection…');
        await this._saveConnection();

        const url = normalizeServerUrl(this._urlRow.text);
        this._urlRow.text = url;
        if (!url || !this._tokenRow.text) {
            this._showStatus('Enter the server URL and client token');
            return;
        }

        const client = new GotifyClient(url, this._tokenRow.text.trim());
        try {
            const version = await client.getVersion(this._cancellable);
            const apps = await client.getApplications(this._cancellable);
            this._showCategories(apps);
            const warning = isInsecure(url)
                ? ' Warning: without HTTPS the token travels unencrypted.'
                : '';
            this._showStatus(`Connected to Gotify ${version.version}.${warning}`);
        } finally {
            client.destroy();
        }
    }

    _showStatus(text) {
        this._statusRow.title = text;
    }

    _showCategories(apps) {
        this._categoryRows.forEach(row => this._categoriesGroup.remove(row));
        this._categoryRows = apps.map(app => new Adw.ActionRow({
            title: app.name,
            subtitle: app.description,
            use_markup: false,
        }));
        if (this._categoryRows.length === 0)
            this._categoryRows = [new Adw.ActionRow({title: 'No categories found'})];
        this._categoryRows.forEach(row => this._categoriesGroup.add(row));
    }
}
