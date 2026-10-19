import { createDockerProvider, createLocalModelsProvider } from './local-operations.js'
import type { Provider } from './types.js'
import { processesProvider } from './processes.js'
import { createVolumeProvider } from './volume.js'
import { createSpotifyProvider } from './spotify.js'
import { createMutedeckProvider } from './mutedeck.js'
import { createCleanshotProvider } from './cleanshot.js'
import { createClipboardProvider } from './clipboard.js'
import { createNetworkProvider } from './network.js'
import { createBatteryProvider } from './battery.js'
import { createRtkProvider } from './rtk.js'

export const providers: Provider[] = [
  createDockerProvider(),
  createLocalModelsProvider(),
  processesProvider,
  createVolumeProvider(),
  createSpotifyProvider(),
  createMutedeckProvider(),
  createCleanshotProvider(),
  createClipboardProvider(),
  createNetworkProvider(),
  createBatteryProvider(),
  createRtkProvider(),
]
