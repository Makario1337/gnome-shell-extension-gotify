import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {State} from './lib/service.js';

const MAX_BADGE_COUNT = 99;

const STATE_LABELS = {
    [State.STOPPED]: 'Not connected',
    [State.CONNECTING]: 'Connecting…',
    [State.CONNECTED]: 'Connected',
    [State.RETRYING]: 'Connection interrupted, retrying soon',
    [State.UNCONFIGURED]: 'Not set up yet',
    [State.AUTH_FAILED]: 'Authentication failed',
};

export const GotifyIndicator = GObject.registerClass(
class GotifyIndicator extends PanelMenu.Button {
    _init(extension, service) {
        super._init(0.5, 'Gotify');
        this._service = service;

        // PanelMenu.Button toggles its menu on any button. Keep that for the
        // secondary button only; the primary one opens the messages window.
        this._clickGesture.set_required_button(Clutter.BUTTON_SECONDARY);
        const primaryClick = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY});
        primaryClick.connect('recognize', () => extension.openMessages());
        this.add_action(primaryClick);

        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/gotify-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._badge = new St.Label({
            style_class: 'gotify-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._badge);
        this.add_child(box);

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Open Messages', () => extension.openMessages());
        this._readItem = this.menu.addAction('Mark All as Read',
            () => service.markAllRead());
        this._connectionItem = this.menu.addAction('', () => {
            if (service.running)
                service.stop();
            else
                service.start();
        });
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => extension.openPreferences());

        service.connectObject(
            'state-changed', () => this._syncState(),
            'unread-changed', () => this._syncUnread(),
            this);
        this._syncState();
        this._syncUnread();
    }

    _syncState() {
        const {state, detail, running} = this._service;
        const label = STATE_LABELS[state];
        this._statusItem.label.text = detail ? `${label}: ${detail}` : label;
        this._connectionItem.label.text = running ? 'Disconnect' : 'Connect';

        if (state === State.CONNECTED)
            this._icon.remove_style_class_name('gotify-offline');
        else
            this._icon.add_style_class_name('gotify-offline');
    }

    _syncUnread() {
        const count = this._service.unreadCount;
        this._badge.text = count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : `${count}`;
        this._badge.visible = count > 0;
        this._readItem.visible = count > 0;
    }
});
