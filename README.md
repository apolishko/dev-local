# dev-local

Репозиторий для хранения локальных конфигураций (`local/`) разных проектов.  
Содержимое этих директорий не попадает в основные репозитории команд, но может быть закоммичено здесь для личного использования и бэкапа.

## Общая схема

- В каждом проекте каталог `local` **игнорируется** в `.gitignore`.
- В `dev-local` для каждого проекта создаётся свой подкаталог:

```
dev-local/
pearson-pce-backend/local
idunn/local
another-project/local
```

- В самом проекте `local` делается **ссылкой** (junction или symlink) на соответствующий каталог внутри `dev-local`.

## Настройка

### Windows-проекты (пример: pearson-pce-backend)

1. Удалить старый `local`:
   ```powershell
   Remove-Item C:\Work\Pearson\pearson-pce-backend\local -Recurse -Force
   ```

2. Создать junction на NTFS:

```
New-Item -ItemType Junction `
  -Path   C:\Work\Pearson\pearson-pce-backend\local `
-Target C:\Work\dev-local\pearson-pce-backend\local
```

### WSL-проекты (пример: idunn)

1. Удалить старый local:
```
rm -rf ~/work/projects/idunn/local
```


2. Создать симлинк на /mnt/c/Work/dev-local:
```
ln -s /mnt/c/Work/dev-local/idunn/local ~/work/projects/idunn/local
```

Теперь ~/work/projects/idunn/local работает как локальная папка проекта, но данные реально лежат в dev-local.

### Gitignore

Чтобы ссылки (local) не попадали в гит основного проекта:

В .gitignore каждого проекта должно быть правило:
```
/local
```

> ----------------------------------------

.\rename-with-prefix.ps1 -Folder "C:\Work\dev-local\idunn\local\features\603" -WhatIf
.\rename-with-prefix.ps1 -Folder "C:\Work\dev-local\idunn\local\features\603"
