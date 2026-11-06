UUID := gotify@makario1337.github.io
BUNDLE := $(UUID).shell-extension.zip

.PHONY: pack install uninstall clean

pack:
	glib-compile-schemas schemas
	gnome-extensions pack --force \
		--extra-source=lib --extra-source=window --extra-source=icons \
		--extra-source=indicator.js --extra-source=notifier.js

install: pack
	gnome-extensions install --force $(BUNDLE)

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -f $(BUNDLE) schemas/gschemas.compiled
