#!/usr/bin/env node

import { prepareKoffi } from '../packages/subprocess/subprocess-local/scripts/prepare-native.mjs'

prepareKoffi([process.cwd()])
