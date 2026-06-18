$cliDir = "C:\Users\Marco\Desktop\projetos\mp3-dtails\cli"
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if ($p -notlike "*mp3-dtails\cli*") {
    [Environment]::SetEnvironmentVariable("Path", $p + ";" + $cliDir, "User")
    Write-Host "Adicionado ao PATH do usuario"
} else {
    Write-Host "Ja esta no PATH"
}
