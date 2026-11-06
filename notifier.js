import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Above this, e.g. after a long time offline, one summary replaces the banners.
const MAX_INDIVIDUAL_NOTIFICATIONS = 3;
const MAX_BODY_LENGTH = 500;
const ICON_NAME = 'mail-unread-symbolic';

function urgencyFor(priority) {
    // Follows the priority ranges the Gotify clients use.
    if (priority >= 8)
        return MessageTray.Urgency.HIGH;
    if (priority >= 4)
        return MessageTray.Urgency.NORMAL;
    return MessageTray.Urgency.LOW;
}

function parseDate(iso) {
    const date = iso ? GLib.DateTime.new_from_iso8601(iso, null) : null;
    return date?.to_local() ?? undefined;
}

export class Notifier {
    constructor(onActivated) {
        this._onActivated = onActivated;
        this._sources = new Map(); // One per category, so GNOME groups them.
    }

    /**
     * @param {object[]} messages - Gotify messages, oldest first
     * @param {function(number): string} appName - maps appid to category name
     */
    show(messages, appName) {
        if (messages.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
            this._post('Gotify', {
                title: `${messages.length} new messages`,
                urgency: MessageTray.Urgency.NORMAL,
            });
            return;
        }

        for (const {appid, title, message, priority, date} of messages) {
            const name = appName(appid);
            this._post(name, {
                title: title || name,
                body: (message ?? '').slice(0, MAX_BODY_LENGTH),
                urgency: urgencyFor(priority),
                datetime: parseDate(date),
            });
        }
    }

    _post(sourceName, params) {
        const source = this._getSource(sourceName);
        const notification = new MessageTray.Notification({source, ...params});
        notification.connect('activated', () => this._onActivated());
        source.addNotification(notification);
    }

    _getSource(name) {
        let source = this._sources.get(name);
        if (source)
            return source;

        source = new MessageTray.Source({title: name, iconName: ICON_NAME});
        source.connect('destroy', () => this._sources.delete(name));
        Main.messageTray.add(source);
        this._sources.set(name, source);
        return source;
    }

    destroy() {
        [...this._sources.values()].forEach(source => source.destroy());
    }
}
