import { Extension, Parameter } from 'talkops'
import WebSocket from 'ws'
import yaml from 'js-yaml'

import floorsModel from './models/floors.json' with { type: 'json' }
import roomsModel from './models/rooms.json' with { type: 'json' }
import lightsModel from './models/lights.json' with { type: 'json' }
import shuttersModel from './models/shutters.json' with { type: 'json' }
import sensorsModel from './models/sensors.json' with { type: 'json' }
import scenesModel from './models/scenes.json' with { type: 'json' }
import updateLightsFunction from './functions/update_lights.json' with { type: 'json' }
import triggerScenesFunction from './functions/trigger_scenes.json' with { type: 'json' }
import updateShuttersFunction from './functions/update_shutters.json' with { type: 'json' }

const wsBaseUrl = new Parameter('WS_BASE_URL')
  .setDescription('The Web Socket base URL of your Home Assistant server.')
  .setPossibleValues(['ws://home-assistant:8123', 'wss://home-assistant.mydomain.net'])
  .setType('url')

const acessToken = new Parameter('ACCESS_TOKEN')
  .setDescription('The generated long-lived access token.')
  .setPossibleValues(['eyJhbGciOiJIUzI1NiIs...'])
  .setType('password')

const extension = new Extension()
  .setName('Home Assistant')
  .setWebsite('https://www.home-assistant.io/')
  .setCategory('home_automation')
  .setIcon(
    'https://play-lh.googleusercontent.com/bGn6qxUHwqZmgtv7RwgxCzl4Uy26SFQrJljVmoOvoIKWa-Xty8s0vOUWcgovUAEAKXnI',
  )
  .setFeatures([
    'Lights: Check status, turn on/off',
    'Shutters: Check status, open, close and stop',
    'Scene: Trigger',
    'Sensors: Check status',
  ])
  .setinstallationSteps([
    'Open Home Assitant from a web browser with admin permissions.',
    'Open the \`Profile\` page by clicking on your username at the bottom left.',
    'Navigate to \`Security\` tab and scroll down to \`Long-lived access tokens\` card.',
    'Click on the button \`Create Token\`, called the token \`TalkOps\` and validate.',
    'Use the generated token to setup the parameter or the environment variable \`ACCESS_TOKEN\`.',
  ])
  .setParameters([wsBaseUrl, acessToken])
  .setFunctions([
    async function trigger_scenes(ids) {
      for (const id of ids) {
        if (
          !call('call_service', {
            domain: 'scene',
            service: 'turn_on',
            target: {
              entity_id: id,
            },
          })
        ) {
          return 'Error during internal request.'
        }
      }
      return 'Done.'
    },
    async function update_lights(action, ids) {
      for (const id of ids) {
        if (
          !call('call_service', {
            domain: 'light',
            service: `turn_${action}`,
            target: {
              entity_id: id,
            },
          })
        ) {
          return 'Error during internal request.'
        }
      }
      return 'Done.'
    },
    async function update_shutters(action, ids) {
      for (const id of ids) {
        if (
          !call('call_service', {
            domain: 'cover',
            service: `${action}_cover`,
            target: {
              entity_id: id,
            },
          })
        ) {
          return 'Error during internal request.'
        }
      }
      return 'Done.'
    },
  ])
  .start()

const baseInstructions = `
You are a home automation assistant, focused solely on managing connected devices in the home.
When asked to calculate an average, **round to the nearest whole number** without explaining the calculation.
`
const defaultInstructions = `
Currently, there is no connected devices.
Your sole task is to ask the user to install one or more connected devices in the home before proceeding.
`

const types = new Map()
const units = new Map()
const states = new Map()

let id = 1
let floors = []
let rooms = []
let lights = []
let shutters = []
let sensors = []
let scenes = []
let socket = null

function udpateMemory() {
  const instructions = [baseInstructions]
  if (!lights.length && !shutters.length && !sensors.length && !scenes.length) {
    instructions.push(defaultInstructions)
  } else {
    instructions.push('``` yaml')
    instructions.push(
      yaml.dump({
        floorsModel,
        roomsModel,
        lightsModel,
        shuttersModel,
        sensorsModel,
        scenesModel,
        floors,
        rooms,
        lights,
        shutters,
        sensors,
        scenes,
      }),
    )
    instructions.push('```')
  }
  extension.setInstructions(instructions.join('\n'))

  const functionSchemas = []
  if (lights) {
    functionSchemas.push(updateLightsFunction)
  }
  if (scenes) {
    functionSchemas.push(triggerScenesFunction)
  }
  if (shutters) {
    functionSchemas.push(updateShuttersFunction)
  }
  extension.setFunctionSchemas(functionSchemas)
}
udpateMemory()

function call(type, params) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false
  }
  socket.send(JSON.stringify({ type, id, ...params }))
  types.set(id, type)
  id++
  return true
}

let refreshTimeout = null
function refresh() {
  refreshTimeout && clearTimeout(refreshTimeout)
  call('get_config')
  call('get_states')
  call('config/floor_registry/list')
  call('config/area_registry/list')
  call('config/entity_registry/list')
  refreshTimeout = setTimeout(refresh, 60000)
}

let connectTimeout = null
function connect() {
  connectTimeout && clearTimeout(connectTimeout)
  floors = []
  rooms = []
  lights = []
  shutters = []
  sensors = []
  scenes = []
  socket = new WebSocket(`${wsBaseUrl.getValue()}/api/websocket`)
  socket.onopen = () => {
    console.log('Connection')
    socket.send(
      JSON.stringify({
        type: 'auth',
        access_token: acessToken.getValue(),
      }),
    )
  }
  socket.onerror = (err) => {
    if (extension.isEnabled()) return
    console.error(err.message)
  }
  socket.onclose = () => {
    connectTimeout = setTimeout(connect, 5000)
  }
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.type === 'auth_ok') {
      console.log('Authentication successful')
      refresh()
    }
    if (data.type === 'auth_invalid') {
      connectTimeout = setTimeout(connect, 5000)
      id = 1
      console.error('Authentication failure')
    }
    if (data.type === 'result' && data.success) {
      update(data)
    }
  }
}

function update(data) {
  const type = types.get(data.id)
  if (type === 'get_config') {
    extension.setSoftwareVersion(data.result.version)
  }
  if (type === 'get_states') {
    data.result.forEach((entity) => {
      states.set(entity.entity_id, entity.state)
    })
    data.result
      .filter((entity) => entity.attributes.unit_of_measurement !== undefined)
      .forEach((entity) => {
        units.set(entity.entity_id, entity.attributes.unit_of_measurement)
      })
  }
  if (type === 'config/floor_registry/list') {
    floors = data.result.map((floor) => {
      return {
        id: floor.floor_id,
        name: floor.name,
        level: floor.level,
      }
    })
  }
  if (type === 'config/area_registry/list') {
    rooms = data.result.map((area) => {
      return {
        id: area.area_id,
        name: area.name,
        floor_id: area.floor_id,
      }
    })
  }
  if (type === 'config/entity_registry/list') {
    lights = data.result
      .filter((entity) => entity.entity_id.startsWith('light'))
      .map((entity) => {
        return {
          id: entity.entity_id,
          name: entity.name || entity.original_name,
          state: states.get(entity.entity_id),
          area_id: entity.area_id,
        }
      })
    shutters = data.result
      .filter((entity) => entity.entity_id.startsWith('cover'))
      .map((entity) => {
        return {
          id: entity.entity_id,
          name: entity.name || entity.original_name,
          state: states.get(entity.entity_id),
          area_id: entity.area_id,
        }
      })
    sensors = data.result
      .filter(
        (entity) =>
          entity.entity_id.startsWith('sensor') &&
          states.get(entity.entity_id) &&
          units.get(entity.entity_id),
      )
      .map((entity) => {
        return {
          id: entity.entity_id,
          name: entity.name || entity.original_name,
          value: states.get(entity.entity_id),
          unit: units.get(entity.entity_id),
          area_id: entity.area_id,
        }
      })
    scenes = data.result
      .filter((entity) => entity.entity_id.startsWith('scene'))
      .map((entity) => {
        return {
          id: entity.entity_id,
          name: entity.name || entity.original_name,
          area_id: entity.area_id,
        }
      })
  }
  udpateMemory()
}

extension.on('boot', connect)
