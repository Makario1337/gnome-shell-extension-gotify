import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {WINDOW_APP_ID} from './lib/constants.js';
import {GotifyService} from './lib/service.js';
import {GotifyIndicator} from './indicator.js';
import {Notifier} from './notifier.js';

export default class GotifyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._service = new GotifyService(this._settings);
        this._notifier = new Notifier(() => this.openMessages());
        this._indicator = new GotifyIndicator(this, this._service);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._service.connectObject('new-messages', (_service, messages) => {
            if (this._settings.get_string('delivery-mode') === 'notifications')
                this._notifier.show(messages, id => this._service.appName(id));
        }, this);

        this._settings.connectObject('changed::autostart', () => this._applyAutostart(), this);
        this._applyAutostart();
    }

    disable() {
        // disable() also runs when the screen locks, so a messages window that
        // is open stays untouched: it is a separate application.
        this._settings.disconnectObject(this);
        this._indicator.destroy();
        this._indicator = null;
        this._notifier.destroy();
        this._notifier = null;
        this._service.destroy();
        this._service = null;
        this._settings = null;
    }

    _applyAutostart() {
        if (this._settings.get_boolean('autostart'))
            this._service.start();
        else
            this._service.stop();
    }

    openMessages() {
        const existing = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(window => window.get_gtk_application_id() === WINDOW_APP_ID);
        if (existing) {
            Main.activateWindow(existing);
            return;
        }

        // GTK can't be loaded into the shell, so the window is its own process.
        // spawnApp() passes an activation token, which Wayland needs for focus.
        // It joins the arguments into a command line, hence the quoting.
        Util.spawnApp(['gjs', '-m', GLib.shell_quote(`${this.path}/window/main.js`)]);
    }
}
