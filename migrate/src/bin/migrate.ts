#!/usr/bin/env node
import { migrateCli } from "../cli.ts";

process.exitCode = await migrateCli();
