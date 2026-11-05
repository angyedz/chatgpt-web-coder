# Канал предварительных выпусков

[English version](PRE-RELEASE.en.md)

Ветка `pre-release` предназначена для экспериментальных сборок chatgpt-coder для Windows.

- Ветка `main` публикует стабильные GitHub Releases.
- Ветка `pre-release` публикует GitHub Pre-releases после успешной проверки Windows CI.
- Ветки функций и pull request проходят CI, но не публикуют релизы.
- Чтобы выбрать этот канал в терминале, выполни `/update settings channel pre-release`.
- Команды `/update check` и `/update latest` используют сохранённый канал.
- Установка всегда требует явной команды `/update apply`.

Считай предварительные версии экспериментальными. Переноси изменения в `main` после проверки и ревью.
