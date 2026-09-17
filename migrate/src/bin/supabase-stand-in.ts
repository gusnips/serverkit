#!/usr/bin/env node
import { standInCli } from "../stand-in.ts";

process.exitCode = await standInCli();
