#!/usr/bin/env node
import { dbTypesCli } from "../db-types-cli.ts";

process.exitCode = await dbTypesCli();
