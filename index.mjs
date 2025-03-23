import { Extension } from 'talkops'
import pkg from './package.json' with { type: 'json' }

const extension = new Extension()
  .setName('Boilerplate NodeJS')
  .setDockerRepository('ghcr.io/talkops/boilerplate-nodejs')
  .setVersion(pkg.version)
