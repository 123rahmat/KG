import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBusiness } from '../src/tools/finance.js';
import { useTool } from '../src/toolbox.js';

test('a business projection gives months, break-even and funding needed, labelled as an estimate', () => {
  const result = projectBusiness({
    months: 12, startingCash: 100_000, upfrontCost: 300_000, newCustomersPerMonth: 40, newCustomerGrowthPercent: 5,
    monthlyChurnPercent: 0, pricePerCustomerPerMonth: 2000, variableCostPerCustomerPerMonth: 800, fixedCostsPerMonth: 150_000
  });
  assert.equal(result.estimate, true);
  assert.match(result.note, /not a forecast or financial advice/);
  assert.equal(result.months.length, 12);
  assert.equal(result.customersNeededToBreakEven, 125, '150,000 / (2,000 - 800)');
  assert.equal(result.months[0].customers, 40);
  assert.equal(result.breakEvenMonth, result.months.find(month => month.profit >= 0).month);
  assert.equal(result.fundingNeeded, -result.lowestCash, 'it starts 200,000 short and loses money until break-even');
  assert.ok(result.fundingNeeded > 200_000);
  assert.equal(projectBusiness({ months: 500 }).months.length, 60, 'bounded');
});

test('the projection is a ready tool in every workspace', async () => {
  const result = await useTool('finance.project', { months: 3, newCustomersPerMonth: 10, pricePerCustomerPerMonth: 100, fixedCostsPerMonth: 500 }, {});
  assert.equal(result.months.length, 3);
  assert.equal(result.breakEvenMonth, 1);
});
