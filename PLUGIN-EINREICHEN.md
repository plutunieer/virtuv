# Virtuv-Plugin bei Anthropic einreichen (U76)

Du reichst selbst ein, Virtuv macht das nie. Stand der Anleitung: 12.10.2026.
Quellen: https://claude.com/docs/plugins/submit und https://claude.com/docs/plugins/pre-submission-checklist

## Vorher (einmalig)

1. **Lizenz:** erledigt. Es gilt MIT (jeder darf das Plugin nutzen), siehe `plugin/LICENSE` und `plugin.json`.
   Ohne Lizenz würde die Einreichung blockiert.
2. **Plugin-Repo aktualisieren.** Das musst du nach jeder Änderung an `plugin/` machen:
   ```bash
   rm -rf /tmp/vp && git clone https://github.com/plutunieer/virtuv-plugin /tmp/vp
   rsync -a --delete --exclude .git --exclude .DS_Store plugin/ /tmp/vp/
   cd /tmp/vp && git add -A && git commit -m "Virtuv plugin <Version>" && git push
   ```
3. **Selbst prüfen:** `claude plugin validate ./plugin --strict` muss „Validation passed“ melden.
4. **Icon:** liegt in `plugin/.claude-plugin/icon.png`, kommt mit Schritt 2 ins Repo (1024×1024 px). Es wird nur beim ersten Einreichen übernommen,
   später nicht mehr änderbar. Deshalb erst einreichen, wenn es im Plugin-Repo liegt.
5. **Hinweis:** Drei Dateien sind größer als 256 KB (die gebündelten Programmdateien in `dist/` und `web/dist/`).
   Die werden nicht abgelehnt, aber ein Mensch bei Anthropic schaut sie sich vorher an. Das kann ein paar Tage dauern.

## Einreichen

1. Öffne https://claude.ai/directory/manage. Dafür brauchst du ein bezahltes Claude-Abo (Pro oder Max).
2. Klick auf **Submit new** und wähle **Plugin bundle**.
3. Bei **Repository** trägst du `plutunieer/virtuv-plugin` ein. Pfad und Zweig lässt du leer.
4. Klick auf **Validate**. Steht irgendwo „Blocks“, schick mir den Text, ich behebe es.
   Danach aktualisierst du das Plugin-Repo (siehe „Vorher“, Schritt 2) und klickst auf **Re-validate**.
5. **Listing details:** Name und Beschreibung kommen von selbst aus `plugin.json` und der README.
6. **Data handling:** Hier fragt das Formular, was mit Daten passiert. So beantwortest du es:
   - Werden persönliche Daten erhoben? **Nein.**
   - Werden Daten an fremde Dienste geschickt? **Nein.** Alles bleibt auf dem eigenen Rechner (127.0.0.1).
   - Werden Daten aufbewahrt? Nur im Projektordner, unter `.urs/`.
   - Ist das Plugin für unter 18-Jährige gedacht? **Nein.**
7. **Compliance:** Trag deine Kontakt-Mail ein und hak alle vier Bestätigungen ab.
8. Wähl **Updates per GitHub-Push** (Standard) und klick auf **Submit for review**.

## Danach

- Anthropic prüft das Plugin auf Sicherheit. Schlägt die erste Prüfung fehl, wird es abgelehnt.
- Ist alles in Ordnung, erscheint auf https://claude.ai/directory/manage bei deinem Plugin der Knopf **Publish**.
  Erst wenn du ihn klickst, geht die Version öffentlich. Das gilt auch für jede spätere Version, die per Push ankommt.
- Bis dahin können alle das Plugin schon direkt installieren:
  `claude plugin marketplace add plutunieer/virtuv-plugin` und danach `claude plugin install virtuv@virtuv`.
