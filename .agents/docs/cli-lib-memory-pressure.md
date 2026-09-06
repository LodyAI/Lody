# Memory pressure on the CLI daemon

Why `session-gc-manager.ts` and `utils/memory.ts` measure what they measure. Binding
rules live in [`apps/cli/src/lib/AGENTS.md`](../../apps/cli/src/lib/AGENTS.md).

`evaluateMemoryPressure` returns TWO independent verdicts, `evict` and `block`, and
they are deliberately not the same threshold: reclaiming an idle session is invisible
(it is restored on its next turn), while refusing a turn is a user-visible failure.
Every platform below therefore has a wider reclaim condition than its refuse condition.

## macOS

The signal is `kern.memorystatus_vm_pressure_level`, not bytes. WARNING reclaims, only
CRITICAL refuses, and an unreadable level fails open. A byte-threshold fallback would
be wrong: byte estimates cannot see compressor headroom, which is where a Mac's
reclaimable memory lives, so they report pressure on healthy machines.

## Linux

Under a cgroup, `memory.max - memory.current` is NOT headroom. `memory.current` counts
page cache, so a tree scan parks tens of GB of clean cache in it and the cgroup reads
as full while resident memory is a fraction of that. Headroom therefore credits
reclaimable cache and slab (`computeCgroupReclaimableBytes`). Because that estimate
deliberately excludes `active_file`, it is allowed to RECLAIM on its own but refusing a
turn additionally requires a real stall — `memory.pressure` some avg10, or a hard
headroom floor on kernels without PSI. Host `MemAvailable` needs no such corroboration;
it is already reclaim-aware.

## Windows

The commit limit is NOT a hard ceiling. With the default system-managed page file it is
`RAM + current page file size`, and Microsoft documents that Windows grows the page file
once commit charge reaches 90% of the limit, so a healthy machine sits permanently a few
hundred MB under its CURRENT limit. `utils/memory.ts` therefore also measures the page
file configuration (`computeWindowsCommitGrowthBytes`, pure and testable) and refuses
only on `effectiveAvailableCommitBytes = availableCommit + growth`; raw commit headroom
and low `AvailableBytes` may only RECLAIM.

The documented system-managed ceiling is `min(max(3 x RAM, 4GB), volume size / 8)`, and
the volume/8 term is load-bearing: it binds on small disks, which are exactly the
machines that do run out of commit. Growth is `number | null`, where `null` means
UNDETERMINED (an unreported volume, or an empty page file enumeration on a machine whose
commit limit exceeds RAM) and drops `effectiveAvailableCommitBytes` so the check fails
open. Collapsing `null` to `0` would manufacture a hard ceiling out of a failed probe.

Physical availability never refuses on Windows at all: the Memory Manager trims working
sets and pages out rather than failing, which is why Chromium, .NET and SQL Server all
treat physical pressure as a shed-caches signal only. `os.freemem()` is already the
physical number (libuv returns `ullAvailPhys`, i.e. free + zero + standby).

Commit numbers come from `powershell.exe`, preferring the documented
`\Memory\Commit Limit` and `\Memory\Committed Bytes` performance counters and falling
back to `Win32_OperatingSystem` (`TotalVirtualMemorySize`/`FreeVirtualMemory` are
`ullTotalPageFile`/`ullAvailPageFile` in practice, but the CIM documentation does not
say so — hence a fallback, not the primary). The timeout is 5s because a 1s budget
expired exactly on the loaded machines the probe exists to measure, and a failed probe
fails open as on macOS. That probe is a process spawn, so it is cached for 30s: at the
monitor's 5s sweep cadence, forcing it would mean roughly 17k `powershell.exe` launches
a day on an idle daemon.

## Two rules learned from a false refusal

Never act on the cached sample — force a refresh once anything looks like pressure —
and re-check with a short delay before failing a turn (`pressureRecheckAttempts`),
because reclaim returns cache within milliseconds. Eviction is bounded per call
(`maxEvictionsPerCall`) because the caller awaits it on the prompt hot path.

The threshold is a safety MARGIN, never "what a turn needs"; do not phrase it that way
to users.
