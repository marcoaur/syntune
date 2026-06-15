/**
 * @module  devices/device-detection
 * @badge   🟨 DEVICE · WIN-ONLY · CHILD-PROCESS(PowerShell/CIM) · STATELESS-ish
 * @role    Detecção de armazenamentos removíveis no Windows: junta Win32_DiskDrive(USB)→partição→disco lógico e normaliza p/ { serial, drive, label, model, size, free }.
 * @inputs  (nenhum) — consulta o SO via PowerShell encodado
 * @outputs Promise<Array<{ serial, usedVolumeFallback, drive, label, model, size, free }>>
 * @deps    child_process(spawn), Buffer
 * @notes   Serial efetivo = hardware (HW:) com fallback p/ serial de volume (VOL:). Timeout 15s + back-off de logs após timeouts seguidos. Não-Windows: caller não chama.
 */
const { spawn } = require('child_process');

// Junta Win32_DiskDrive (USB/removível) → partição → disco lógico, retornando, por
// volume: serial de hardware do disco, serial do volume (fallback), letra, rótulo e tamanhos.
const PS_DRIVE_QUERY = `
$ErrorActionPreference='SilentlyContinue'
$out=@()
$lds = Get-WmiObject Win32_LogicalDisk -Filter "DriveType=2"
if (-not $lds) { Write-Output '[]'; exit }
$disks = @{}
Get-WmiObject Win32_DiskDrive -Filter "InterfaceType='USB'" | ForEach-Object {
  $d=$_
  $d.GetRelated('Win32_DiskPartition') | ForEach-Object {
    $p=$_
    $p.GetRelated('Win32_LogicalDisk') | ForEach-Object {
      $disks[$_.DeviceID] = @{ serial=($d.SerialNumber -as [string]); model=$d.Model }
    }
  }
}
$lds | ForEach-Object {
  $ld=$_
  $disk=$disks[$ld.DeviceID]
  $out += [pscustomobject]@{
    serial=if($disk){$disk.serial}else{''};
    model=if($disk){$disk.model}else{'Removivel'};
    drive=$ld.DeviceID; label=$ld.VolumeName;
    volSerial=$ld.VolumeSerialNumber; size=$ld.Size; free=$ld.FreeSpace
  }
}
if ($out.Count -eq 0) { Write-Output '[]' } else { $out | ConvertTo-Json -Compress }
`;

let consecutiveTimeouts = 0; // conta timeouts seguidos para back-off de logs

function cleanSerial(s) {
  return (s == null ? '' : String(s)).replace(/\s+/g, '').trim();
}

// monta o serial efetivo: hardware (estável) com fallback para o serial do volume
function normalizeDrive(d) {
  if (!d || !d.drive) return null;
  const hw = cleanSerial(d.serial);
  const vol = cleanSerial(d.volSerial);
  let serial, usedVolumeFallback = false;
  if (hw) serial = 'HW:' + hw;
  else if (vol) { serial = 'VOL:' + vol; usedVolumeFallback = true; }
  else return null;
  return {
    serial, usedVolumeFallback,
    drive: String(d.drive),                 // ex.: "E:"
    label: d.label || '',
    model: d.model || '',
    size: Number(d.size) || 0,
    free: Number(d.free) || 0
  };
}

function queryRemovableDrives() {
  // Detecção implementada só no Windows (Win32_DiskDrive/CIM via PowerShell).
  // Em macOS/Linux a sync vira no-op — o resto do app roda normalmente.
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    const encoded = Buffer.from(PS_DRIVE_QUERY, 'utf16le').toString('base64');
    let ps;
    try {
      ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true });
    } catch { return resolve([]); }

    let stdout = '';
    let settled = false;

    // Timeout de segurança: mata o PowerShell se demorar mais de 15 s
    // (o Windows pode demorar ao inicializar drivers USB recém plugados)
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ps.kill(); } catch { /* já terminou */ }
      consecutiveTimeouts++;
      if (consecutiveTimeouts <= 2) {
        console.warn('[queryRemovableDrives] timeout — PowerShell demorou demais, ignorando.');
      }
      resolve([]);
    }, 15000);

    ps.stdout.on('data', (d) => { stdout += d; });
    ps.stderr.on('data', () => { /* ignora ruído */ });
    ps.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve([]); } });
    ps.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      consecutiveTimeouts = 0; // sucesso — zera o contador
      const txt = stdout.trim();
      if (!txt) return resolve([]);
      let parsed;
      try { parsed = JSON.parse(txt); } catch { return resolve([]); }
      if (!parsed) return resolve([]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      resolve(arr.map(normalizeDrive).filter(Boolean));
    });
  });
}

module.exports = { queryRemovableDrives, normalizeDrive, cleanSerial };
