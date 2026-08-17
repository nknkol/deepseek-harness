#!/usr/bin/env node

import { prepareNodePty } from '../packages/subprocess/subprocess-local/scripts/prepare-native.mjs'

prepareNodePty([process.cwd()])
