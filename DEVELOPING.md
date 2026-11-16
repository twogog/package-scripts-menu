# Разработка Package Scripts Menu

## Быстрый старт

Нужны Git, Node.js и настольный VS Code. Проверено с Node.js 24.

```powershell
git clone https://github.com/twogog/package-scripts-menu.git
cd package-scripts-menu
npm test
npm run check
code .
```

Нажмите **F5** в VS Code. В открывшемся окне Extension Development Host откройте папку тестового проекта и его `package.json`.

Рабочий код не требует установки npm-зависимостей или сборки. Изменения JavaScript подхватываются после перезапуска окна проверки расширения.

## Структура

- `src/extension.js` — события VS Code, меню, запуск и остановка задач.
- `src/core.js` — чтение package.json и выбор менеджера пакетов.
- `src/history.js` — избранное и статистика, отдельные для репозиториев и пакетов.
- `media/menu.js`, `media/menu.css` — интерфейс меню.
- `test/` — модульные и интеграционные проверки.
- `.vscode/launch.json` — конфигурация запуска по F5.

## Проверки

```powershell
npm test
npm run check
```

Проверено на Windows в VS Code 1.133. Модульные тесты проверяют чтение скриптов, определение менеджера и различение сбоя и прерывания. Интеграционные проверки охватывают автоматическое меню и загрузку его интерфейса, запуск и остановку реального процесса, защиту от двойного запуска, имена с пробелами и `&`, рабочую папку с кириллицей, ненулевой код завершения, сохранение изменений и обработку ошибок JSON.

Тесты истории дополнительно проверяют изоляцию двух репозиториев с одинаковыми названиями команд, отдельные пакеты монорепозитория, совместное обновление избранного и счётчика и восстановление после перезапуска настоящего окна VS Code.

Интеграционный тест `test/integration.js` запускается в Extension Host VS Code. Подготовить его безвредные скрипты и запустить с изолированными настройками можно из папки исходников:

```powershell
$extensionPath = (Get-Location).Path
node test/prepare-integration.js ../menu-test
$fixturePath = (Resolve-Path ../menu-test).Path
code --new-window --disable-extensions --disable-workspace-trust --skip-welcome --user-data-dir ../menu-test-user --extensions-dir ../menu-test-extensions --extensionDevelopmentPath "$extensionPath" --extensionTestsPath "$extensionPath/test/integration.js" "$fixturePath"
```

Результат появится в `../integration-result.json`. Окно проверки закроется само. Флаг `--disable-workspace-trust` применяется только к тестовому окну и не нужен для обычного использования расширения.

Остановка дополнительно проверена на Windows с Git Bash: дерево из трёх процессов, два TCP-порта, выполнение cleanup, ручное прерывание с кодом `512` и таймаут при игнорировании Ctrl+C. После проверок все тестовые процессы завершились и порты освободились. Это проверка тестового сервера; поведение конкретного проекта зависит от его обработчиков остановки.

Для повторения этой проверки используйте `node test/prepare-stop-check.js ../stop-test "C:\путь\Git\bin\bash.exe"`, а затем запустите отдельный Extension Host аналогично примеру выше, указав папку `../stop-test` и `--extensionTestsPath "$extensionPath/test/stop.integration.js"`. Отчёт будет в `../stop-check-result.json`.

Для проверки сохранения истории выполните `node test/prepare-history-check.js ../history-test`. Затем дважды запустите VS Code с отдельной папкой `--user-data-dir`, папкой `../history-test` и двумя параметрами `--extensionDevelopmentPath`: папка расширения и её подпапка `test/history-driver`. Не используйте `--extensionTestsPath` в этой проверке: VS Code намеренно отключает дисковое хранилище в штатном тестовом режиме. Первое окно создаёт записи и закрывается; второе проверяет сохранение после перезапуска. Отчёт появится в `../history-test/history-result.json`.

## Сборка VSIX

Для сборки установочного файла используется официальный инструмент Microsoft `@vscode/vsce`. При первом запуске npm загрузит его из реестра:

```powershell
npm run package
```

Справка: [API задач VS Code](https://code.visualstudio.com/api/references/vscode-api#tasks), [установка и упаковка VSIX](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions).
