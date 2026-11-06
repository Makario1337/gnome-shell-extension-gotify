// The client token grants full access to the Gotify account, so it lives in
// the user's keyring instead of world-readable dconf.
import Secret from 'gi://Secret';

const ATTRIBUTES = {kind: 'client-token'};

// Built on demand: GObject types must not be created while the module loads.
function createSchema() {
    return new Secret.Schema(
        'org.gnome.shell.extensions.gotify',
        Secret.SchemaFlags.NONE,
        {kind: Secret.SchemaAttributeType.STRING});
}

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

/**
 * @returns {Promise<string|null>} the stored client token, if there is one
 */
export function lookupToken() {
    return promisified(
        cb => Secret.password_lookup(createSchema(), ATTRIBUTES, null, cb),
        Secret.password_lookup_finish);
}

/**
 * @param {string} token - client token to store in the keyring
 * @returns {Promise<boolean>} whether the token was stored
 */
export function storeToken(token) {
    return promisified(
        cb => Secret.password_store(createSchema(), ATTRIBUTES, Secret.COLLECTION_DEFAULT,
            'Gotify client token', token, null, cb),
        Secret.password_store_finish);
}

/**
 * @returns {Promise<boolean>} whether a token was removed
 */
export function clearToken() {
    return promisified(
        cb => Secret.password_clear(createSchema(), ATTRIBUTES, null, cb),
        Secret.password_clear_finish);
}
