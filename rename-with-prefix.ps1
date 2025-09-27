[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$Folder,

    [int]$Step = 10,     # шаг нумерации (по умолчанию 10: 10, 20, 30, ...)
    [int]$Start = 10     # стартовое значение (по умолчанию 10 => первый файл #0010-...)
)

if (-not (Test-Path -LiteralPath $Folder)) {
    Write-Error "Каталог не существует: $Folder"
    exit 1
}

# Берём только файлы из указанной папки, сортируем от старых к новым по дате изменения
$files = Get-ChildItem -LiteralPath $Folder -File | Sort-Object LastWriteTime

if ($files.Count -eq 0) {
    Write-Host "Файлов не найдено в: $Folder"
    exit 0
}

# Жёстко задаём ширину 4 (NNNN)
$width = 4

# Регекс для сноса старого префикса в начале имени: #<цифры>-
$oldPrefixPattern = '^(#\d+-\s*)'

$i = 0
foreach ($file in $files) {
    $current = $Start + ($i * $Step)
    $prefix = ("#{0:D$width}" -f $current)

    # Чистим старый префикс, если он есть
    $cleanName = ($file.Name -replace $oldPrefixPattern, '')

    $newName = "$prefix-$cleanName"
    $newPath = Join-Path $Folder $newName

    if ($file.Name -eq $newName) {
        Write-Host "Пропускаю: уже ок -> $newName"
    }
    elseif (Test-Path -LiteralPath $newPath) {
        Write-Warning "Пропуск: целевое имя уже существует -> $newName"
    }
    else {
        if ($PSCmdlet.ShouldProcess($file.Name, "Rename -> $newName")) {
            Rename-Item -LiteralPath $file.FullName -NewName $newName
            Write-Host "OK: $($file.Name) -> $newName"
        }
    }

    $i++
}
