param([Parameter(Mandatory = $true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-process-owner.cs') -ReferencedAssemblies 'System.Web.Extensions'
[Loom.ProcessOwner]::Run($PipeName)
