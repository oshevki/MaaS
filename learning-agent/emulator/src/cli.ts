#!/usr/bin/env ts-node

/**
 * Test Runner CLI
 *
 * Command-line interface for running test scenarios
 *
 * Usage:
 *   npm run test-runner                    # Interactive mode
 *   npm run test-runner <scenario-id>      # Run specific scenario
 */

import * as readline from 'readline';
import { TestRunnerEngine, TestMode } from './engine';
import { closePool } from '../../../shared/db';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function printUsage(): void {
  console.log(`
MaaS MVP Test Runner

Usage:
  npm run test-runner
  npm run test-runner -- <scenario-id>
  npm run test-runner -- --help

Modes:
  Interactive mode starts in MOCK mode and can toggle between MOCK and FULL.
  DIRECT and FULL modes require runtime dependencies such as OPENAI_API_KEY and DATABASE_URL.
`);
}

async function listScenarios(runner: TestRunnerEngine): Promise<void> {
  console.log('\n📋 Available Test Scenarios:');
  console.log('─'.repeat(80));

  const scenarios = await runner.getScenarios();

  scenarios.forEach((scenario, index) => {
    console.log(`\n${index + 1}. Scenario ID: ${scenario.scenario_id}`);
    console.log(`   Steps: ${scenario.step_count}`);
    console.log(`   First query: "${scenario.first_query}"`);
  });

  console.log('\n' + '─'.repeat(80));
}

async function runScenario(runner: TestRunnerEngine, scenarioId: string): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 TEST RUNNER');
  console.log('='.repeat(80));

  const results = await runner.runScenario(scenarioId);

  // Print summary
  console.log('\n' + '─'.repeat(80));
  console.log('📊 SUMMARY');
  console.log('─'.repeat(80));

  const passed = results.filter(r => r.status === 'PASSED').length;
  const failed = results.filter(r => r.status === 'FAILED').length;

  console.log(`Total steps:  ${results.length}`);
  console.log(`✅ Passed:    ${passed}`);
  console.log(`❌ Failed:    ${failed}`);
  console.log(`Success rate: ${((passed / results.length) * 100).toFixed(1)}%`);

  // Print detailed results
  console.log('\n' + '─'.repeat(80));
  console.log('📝 DETAILED RESULTS');
  console.log('─'.repeat(80));

  for (const result of results) {
    const statusIcon = result.status === 'PASSED' ? '✅' : '❌';
    console.log(`\n${statusIcon} Step ${result.step}: ${result.status}`);

    if (result.final_answer) {
      console.log(`   Answer: ${result.final_answer.substring(0, 100)}${result.final_answer.length > 100 ? '...' : ''}`);
    }

    if (result.validation_result) {
      console.log(`   Validation: ${result.validation_result.reason}`);
    }

    if (result.error_message) {
      console.log(`   Error: ${result.error_message}`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

async function interactiveMode(runner: TestRunnerEngine): Promise<void> {
  while (true) {
    console.log('\n🧪 Test Runner CLI');
    console.log('─'.repeat(40));
    console.log('1. List scenarios');
    console.log('2. Run scenario');
    console.log('3. Toggle mode (current: ' + runner.getMode().toUpperCase() + ')');
    console.log('4. Exit');
    console.log('─'.repeat(40));

    const choice = await question('\nSelect option: ');

    switch (choice.trim()) {
      case '1':
        await listScenarios(runner);
        break;

      case '2':
        const scenarioId = await question('\nEnter scenario ID: ');
        try {
          await runScenario(runner, scenarioId.trim());
        } catch (error: any) {
          console.error(`\n❌ Error: ${error.message}`);
        }
        break;

      case '3':
        const currentMode = runner.getMode();
        const newMode = currentMode === TestMode.MOCK ? TestMode.FULL : TestMode.MOCK;
        runner.setMode(newMode);
        console.log(`\n✅ Mode changed to: ${newMode.toUpperCase()}`);
        break;

      case '4':
        console.log('\n👋 Goodbye!');
        rl.close();
        await closePool();
        process.exit(0);

      default:
        console.log('\n❌ Invalid option');
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printUsage();
    rl.close();
    process.exit(0);
  }

  // Create Test Runner in mock mode by default
  const runner = new TestRunnerEngine({ mode: TestMode.MOCK });

  console.log('\n🚀 MaaS MVP Test Runner');
  console.log('Version: 1.0.0');
  console.log('Mode: ' + runner.getMode().toUpperCase());

  try {
    if (args.length > 0) {
      // Direct execution mode
      const scenarioId = args[0];
      await runScenario(runner, scenarioId);
      await closePool();
      process.exit(0);
    } else {
      // Interactive mode
      await interactiveMode(runner);
    }
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    await closePool();
    process.exit(1);
  }
}

main();
