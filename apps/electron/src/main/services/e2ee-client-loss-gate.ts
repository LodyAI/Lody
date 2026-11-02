import { app } from 'electron'

/** Unpackaged `LODY_E2E=1` automation only; packaged builds never count or register the probe. */
export const clientLossProbeEnabled = (): boolean => !app.isPackaged && process.env.LODY_E2E === '1'
