// The client token grants full access to the Gotify account, so it lives in
// the user's keyring instead of world-readable dconf.
import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.gotify',
    Secret.SchemaFlags.NONE,
    {kind: Secret.SchemaAttributeType.STRING});
const ATTRIBUTES = {kind: 'client-token'};

function promisified(start, finish) {
    return new Promise((resolve, reject) => {
        start((_source, result) => {
            try {
                resolve(finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function lookupToken() {
    return promisified(
        cb => Secret.password_lookup(SCHEMA, ATTRIBUTES, null, cb),
        Secret.password_lookup_finish);
}

export function storeToken(token) {
    return promisified(
        cb => Secret.password_store(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT,
            'Gotify client token', token, null, cb),
        Secret.password_store_finish);
}

export function clearToken() {
    return promisified(
        cb => Secret.password_clear(SCHEMA, ATTRIBUTES, null, cb),
        Secret.password_clear_finish);
}
