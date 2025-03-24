import { Extension, Parameter } from 'talkops'
import pkg from './package.json' with { type: 'json' }

const wsBaseUrl = new Parameter('WS_BASE_URL')
  .setDescription('The Web Socket base URL of your Home Assistant server.')
  .setPossibleValues(['ws://home-assistant:8123', 'wss://home-assistant.mydomain.net'])

const acessToken = new Parameter('ACCESS_TOKEN').setDescription(
  'The generated long-lived access token.',
)

const extension = new Extension()
  .setName('Home Assistant')
  .setWebsite('https://www.home-assistant.io/')
  .setCategory('Home Automation')
  .setIcon(
    'https://play-lh.googleusercontent.com/bGn6qxUHwqZmgtv7RwgxCzl4Uy26SFQrJljVmoOvoIKWa-Xty8s0vOUWcgovUAEAKXnI',
  )
  .setVersion(pkg.version)
  .setDockerRepository('bierdok/talkops-home-assistant')
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

import floorsModel from './schemas/models/floors.json' with { type: 'json' }
import roomsModel from './schemas/models/rooms.json' with { type: 'json' }
import lightsModel from './schemas/models/lights.json' with { type: 'json' }
import shuttersModel from './schemas/models/shutters.json' with { type: 'json' }
import sensorsModel from './schemas/models/sensors.json' with { type: 'json' }
import scenesModel from './schemas/models/scenes.json' with { type: 'json' }

import updateLightsFunction from './schemas/functions/update_lights.json' with { type: 'json' }
import triggerScenesFunction from './schemas/functions/trigger_scenes.json' with { type: 'json' }
import updateShuttersFunction from './schemas/functions/update_shutters.json' with { type: 'json' }

const baseInstructions = `
You are a home automation assistant, focused solely on managing connected devices in the home.
When asked to calculate an average, **round to the nearest whole number** without explaining the calculation.
`

const defaultInstructions = `
Currently, there is no connected devices.
Your sole task is to ask the user to install one or more connected devices in the home before proceeding.
`

import WebSocket from 'ws'
import yaml from 'js-yaml'

let id = 1
const types = new Map()
const units = new Map()
const states = new Map()
let floors = []
let rooms = []
let lights = []
let shutters = []
let sensors = []
let scenes = []

let socket = null
let interval = null

function call(type, params) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false
  }
  socket.send(JSON.stringify({ type, id, ...params }))
  types.set(id, type)
  id++
  return true
}

function connect() {
  try {
    socket = new WebSocket(`${wsBaseUrl.getValue()}/api/websocket`)
  } catch (err) {
    extension.addError(err.message)
    setTimeout(connect, 1000)
    return
  }
  socket.onerror = (err) => {
    extension.addError(err.message)
    setTimeout(connect, 1000)
    return
  }
  socket.onopen = () => {
    extension.clearErrors()
    socket.send(
      JSON.stringify({
        type: 'auth',
        access_token: acessToken.getValue(),
      }),
    )
  }
  function refresh() {
    call('get_config')
    call('get_states')
    call('config/floor_registry/list')
    call('config/area_registry/list')
    call('config/entity_registry/list')
  }
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.type === 'auth_ok') {
      extension.clearErrors()
      refresh()
      interval = setInterval(refresh, 5000)
    }
    if (data.type === 'auth_invalid') {
      extension.addError(data.message)
    }
    if (data.type === 'result' && data.success) {
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
        if (type === 'call_service') {
          console.log(data.result)
        }
      }

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
  }
  socket.onclose = () => {
    interval && clearInterval(interval)
    setTimeout(connect, 1000)
    id = 1
    floors = []
    rooms = []
    lights = []
    shutters = []
    sensors = []
    scenes = []
    extension.addError('Server unreachable')
  }
}
connect()

extension.setFunctions([
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
