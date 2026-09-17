import type { Provider } from './types.js'
import { systemProvider } from './system.js'
import { processesProvider } from './processes.js'
import { createVolumeProvider } from './volume.js'
import { createSpotifyProvider } from './spotify.js'
import { createMutedeckProvider } from './mutedeck.js'
import { createCleanshotProvider } from './cleanshot.js'
import { createClipboardProvider } from './clipboard.js'
import { createNetworkProvider } from './network.js'
import { createBatteryProvider } from './battery.js'

export const providers: Provider[] = [
  systemProvider,
  processesProvider,
  createVolumeProvider(),
  createSpotifyProvider(),
  createMutedeckProvider(),
  createCleanshotProvider(),
  createClipboardProvider(),
  createNetworkProvider(),
  createBatteryProvider(),
]
