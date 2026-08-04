import { appClock } from './lib/clock'
import { systemRng } from './lib/ports'
import { redis } from './redis/client'
import { WindowStore } from './store/windowStore'
import { BreakerStore } from './store/breakerStore'
import { RoutingService } from './services/routingService'
import { ChannelHealthService } from './services/channelHealthService'
import { AdminService } from './services/adminService'
import { HealthService } from './services/healthService'
import { ContractStatusService } from './services/contractStatusService'
import { RoutingController } from './controllers/routing.controller'
import { ChannelController } from './controllers/channel.controller'
import { AdminController } from './controllers/admin.controller'
import { HealthController } from './controllers/health.controller'
import { ContractController } from './controllers/contract.controller'

/**
 * Composition, in ONE place.
 *
 * The clock and the random source are injected here, at the edge. Everything
 * below takes them as arguments, so the domain never reads the wall clock and
 * never calls Math.random(). That single rule is why every unit test in this
 * repository is exact.
 */
export interface Container {
  stores: {
    windows: WindowStore
    breakers: BreakerStore
  }
  services: {
    routing: RoutingService
    channelHealth: ChannelHealthService
    admin: AdminService
    health: HealthService
    contracts: ContractStatusService
  }
  controllers: {
    routing: RoutingController
    channels: ChannelController
    admin: AdminController
    health: HealthController
    contracts: ContractController
  }
}

export function buildContainer(): Container {
  const windows = new WindowStore(redis)
  const breakers = new BreakerStore(redis)

  const routing = new RoutingService(windows, breakers, appClock, systemRng)
  const channelHealth = new ChannelHealthService(windows, breakers, appClock)
  const admin = new AdminService(windows, breakers, redis, appClock)
  const health = new HealthService()
  const contracts = new ContractStatusService()

  return {
    stores: { windows, breakers },
    services: { routing, channelHealth, admin, health, contracts },
    controllers: {
      routing: new RoutingController(routing),
      channels: new ChannelController(channelHealth),
      admin: new AdminController(admin),
      health: new HealthController(health),
      contracts: new ContractController(contracts),
    },
  }
}
