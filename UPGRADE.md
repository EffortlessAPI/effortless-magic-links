# Moving a project to a newer version of the seed (for the engine)

The seed's folder is `server/magic-links/`; its version is `seed.version` in its
`effortless-seed.json`, and `CHANGELOG.md` says what each version changed and what a project must
do. Read the CHANGELOG entries between the project's version and the new one first.

## 1. Keep the project's answers, replace the rest

```bash
cp server/magic-links/magic-links.config.json /tmp/ml-config.json
effortless cloneSeed effortlessapi/effortless-magic-links /tmp/ml-new && rm -rf /tmp/ml-new/.git
rm -rf server/magic-links && mv /tmp/ml-new server/magic-links
cp /tmp/ml-config.json server/magic-links/magic-links.config.json
```

A setting the new version no longer knows makes every script stop with "unknown setting(s)":
remove it (the CHANGELOG says what replaced it). A new setting takes its default until set.

Works when: `node server/magic-links/scripts/doctor.mjs` runs (it may report the rows as out of date).

## 2. Rewrite the SQL rows

```bash
node server/magic-links/scripts/install.mjs           # dry run: usually "update the seed's ... block"
node server/magic-links/scripts/install.mjs --write
```

Then rebuild.

Works when: the doctor prints "Everything is wired" and the setup screen says "Ready to publish".

## 3. Follow the CHANGELOG's own steps for each version crossed

Works when: every "a project must" line in the crossed entries is done.
