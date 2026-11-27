import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

const aclScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = ConvertFrom-Json -InputObject $env:ITPAY_MANAGED_PROFILE_ACL
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($current.Value, 'S-1-5-18', 'S-1-5-32-544')
# Windows servicing may own and maintain the system volume and its directories.
$trustedAncestors = $trusted + 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$deleteOrReown = 0x500D0040

function Read-Descriptor([string] $path) {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw 'reparse point'
  }
  $acl = Get-Acl -LiteralPath $path
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
    $acl.GetSecurityDescriptorBinaryForm(), 0
  )
  if ($null -eq $descriptor.DiscretionaryAcl) { throw 'missing DACL' }
  return $descriptor
}

function Assert-Access([string] $path, [bool] $private) {
  $descriptor = Read-Descriptor $path
  $kind = if ($private) { 'managed path' } else { 'ancestor' }
  $allowedSids = if ($private) { $trusted } else { $trustedAncestors }
  if ($descriptor.Owner.Value -notin $allowedSids) {
    throw "untrusted $kind owner"
  }
  $currentAllowed = $false
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace -isnot [System.Security.AccessControl.QualifiedAce] -or
        $ace.IsCallback -or $ace -is [System.Security.AccessControl.ObjectAce]) {
      throw 'unsupported access entry'
    }
    if ($ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
    $inheritOnly = $ace.AceFlags -band [System.Security.AccessControl.AceFlags]::InheritOnly
    if ($inheritOnly -and -not $private) { continue }
    if ($ace.SecurityIdentifier.Value -eq $current.Value -and -not $inheritOnly) {
      $currentAllowed = $true
    }
    if ($ace.SecurityIdentifier.Value -notin $allowedSids -and
        ($private -or ($ace.AccessMask -band $deleteOrReown))) {
      throw "untrusted $kind access"
    }
  }
  if ($private -and -not $currentAllowed) { throw 'user access missing' }
}

$root = $inputData.root
$parent = [System.IO.Directory]::GetParent($root)
if ($null -eq $parent) { throw 'volume root' }
# Walking the ancestry prevents replacement of a trusted directory through DeleteChild.
$ancestor = $parent
while ($null -ne $ancestor) {
  if ($ancestor.Exists) { Assert-Access $ancestor.FullName $false }
  $ancestor = $ancestor.Parent
}

if ($inputData.create -and -not [System.IO.Directory]::Exists($root)) {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $trusted) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new($sid),
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
  }
  [System.IO.Directory]::CreateDirectory($root, $acl) | Out-Null
}
Assert-Access $root $true
foreach ($path in $inputData.paths) {
  try { $null = Get-Item -LiteralPath $path -Force }
  catch [System.Management.Automation.ItemNotFoundException] { continue }
  Assert-Access $path $true
}
`;

const command = `try {
${aclScript}
} catch {
  if ($_.Exception.Message -in @('reparse point', 'missing DACL', 'untrusted managed path owner',
    'untrusted ancestor owner', 'unsupported access entry', 'untrusted managed path access',
    'untrusted ancestor access', 'user access missing')) {
    [Console]::Error.WriteLine($_.Exception.Message)
  }
  [Console]::Error.WriteLine('ACL_LINE_' + $_.InvocationInfo.ScriptLineNumber)
  exit 1
}`;

/** Windows file mode bits do not represent the NTFS owner or DACL. */
export function assertWindowsProfileACL(root: string, paths: string[], create = false): void {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:\\/i.test(root)) throw new Error("API profile requires a private local Windows directory");
  const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64"),
  ], {
    env: { SystemRoot: systemRoot, ITPAY_MANAGED_PROFILE_ACL: JSON.stringify({ root, paths, create }) },
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const message = "API profile requires private Windows ownership and access permissions";
    for (const reason of [
      "reparse point", "missing DACL", "untrusted managed path owner", "untrusted ancestor owner",
      "unsupported access entry", "untrusted managed path access", "untrusted ancestor access", "user access missing",
    ]) {
      if (result.stderr?.includes(reason)) throw new Error(`${message} (${reason})`);
    }
    const line = /ACL_LINE_([0-9]{1,3})\b/.exec(result.stderr ?? "")?.[1];
    if (line) throw new Error(`${message} (ACL line ${line})`);
    if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") throw new Error(`${message} (ACL timeout)`);
    if (result.error) throw new Error(`${message} (ACL helper unavailable)`);
    throw new Error(`${message} (ACL helper failed)`);
  }
}
