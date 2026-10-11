export interface ProcessSample {
  pid: number
  /** Working set in KB, as reported by Electron's app.getAppMetrics(). */
  memoryKb: number
}

export interface ProcessOwner {
  profileId: string
  /** OS process ids of this profile's tab pages. */
  pids: number[]
}

export interface Attribution {
  totalMb: number
  /** Processes not owned by exactly one profile (browser, GPU, network, dashboard, shared). */
  sharedMb: number
  perProfile: Map<string, { memoryMb: number; processCount: number }>
}

const mb = (kb: number): number => Math.round(kb / 1024)

/**
 * Splits app memory between profiles by process id. A process is attributed to a profile only
 * if it is used by that profile alone; anything used by several profiles (or by none) counts as
 * shared. Chromium never shares page processes between different sessions, so profile page
 * processes are normally attributable.
 */
export function attributeMemory(samples: ProcessSample[], owners: ProcessOwner[]): Attribution {
  const ownersByPid = new Map<number, Set<string>>()
  for (const owner of owners) {
    for (const pid of owner.pids) {
      if (!Number.isInteger(pid) || pid <= 0) continue
      const set = ownersByPid.get(pid) ?? new Set<string>()
      set.add(owner.profileId)
      ownersByPid.set(pid, set)
    }
  }

  const perProfileKb = new Map<string, { kb: number; count: number }>()
  for (const owner of owners) perProfileKb.set(owner.profileId, { kb: 0, count: 0 })

  let totalKb = 0
  let sharedKb = 0
  const seen = new Set<number>()
  for (const sample of samples) {
    if (seen.has(sample.pid)) continue // count each process once
    seen.add(sample.pid)
    const kb = Math.max(0, sample.memoryKb)
    totalKb += kb
    const ownersOfPid = ownersByPid.get(sample.pid)
    if (ownersOfPid?.size === 1) {
      const [profileId] = [...ownersOfPid]
      const entry = perProfileKb.get(profileId!)!
      entry.kb += kb
      entry.count++
    } else {
      sharedKb += kb
    }
  }

  const perProfile = new Map<string, { memoryMb: number; processCount: number }>()
  for (const [id, v] of perProfileKb) perProfile.set(id, { memoryMb: mb(v.kb), processCount: v.count })
  return { totalMb: mb(totalKb), sharedMb: mb(sharedKb), perProfile }
}
