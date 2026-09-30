/**
 * A simple, first-party projection for a business idea: customers, revenue,
 * costs, profit and cash month by month, with the break-even month. It needs
 * no sandbox, so every workspace has it. Results are estimates from the
 * assumptions given, and are labelled as such.
 */

import { registerTools } from '../toolbox.js';

const number = (value, fallback, { min = -1e12, max = 1e12 } = {}) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function projectBusiness(input = {}) {
  const months = Math.round(number(input.months, 12, { min: 1, max: 60 }));
  const price = number(input.pricePerCustomerPerMonth, 0, { min: 0 });
  const variable = number(input.variableCostPerCustomerPerMonth, 0, { min: 0 });
  const fixed = number(input.fixedCostsPerMonth, 0, { min: 0 });
  const growth = number(input.newCustomersPerMonth, 0, { min: 0, max: 1e9 });
  const growthRate = number(input.newCustomerGrowthPercent, 0, { min: -100, max: 1000 }) / 100;
  const churn = number(input.monthlyChurnPercent, 0, { min: 0, max: 100 }) / 100;
  let customers = number(input.startingCustomers, 0, { min: 0, max: 1e9 });
  let cash = number(input.startingCash, 0);
  const upfront = number(input.upfrontCost, 0, { min: 0 });
  cash -= upfront;

  const rows = [];
  let breakEvenMonth = null;
  let lowestCash = cash;
  let lowestCashMonth = 0;
  let added = growth;
  for (let month = 1; month <= months; month += 1) {
    const lost = customers * churn;
    customers = Math.max(0, customers - lost + added);
    const revenue = customers * price;
    const costs = fixed + customers * variable;
    const profit = revenue - costs;
    cash += profit;
    if (breakEvenMonth === null && profit >= 0 && revenue > 0) breakEvenMonth = month;
    if (cash < lowestCash) { lowestCash = cash; lowestCashMonth = month; }
    rows.push({ month, customers: Math.round(customers), revenue: Math.round(revenue), costs: Math.round(costs), profit: Math.round(profit), cash: Math.round(cash) });
    added *= 1 + growthRate;
  }
  const marginPerCustomer = price - variable;
  return {
    estimate: true,
    note: 'An estimate from the assumptions given, not a forecast or financial advice. Change the assumptions to test them.',
    assumptions: { months, startingCustomers: number(input.startingCustomers, 0, { min: 0 }), pricePerCustomerPerMonth: price, variableCostPerCustomerPerMonth: variable, fixedCostsPerMonth: fixed, newCustomersPerMonth: growth, newCustomerGrowthPercent: growthRate * 100, monthlyChurnPercent: churn * 100, startingCash: number(input.startingCash, 0), upfrontCost: upfront },
    breakEvenMonth,
    customersNeededToBreakEven: marginPerCustomer > 0 ? Math.ceil(fixed / marginPerCustomer) : null,
    lowestCash: Math.round(lowestCash),
    lowestCashMonth,
    fundingNeeded: lowestCash < 0 ? Math.round(-lowestCash) : 0,
    totals: {
      revenue: rows.reduce((sum, row) => sum + row.revenue, 0),
      profit: rows.reduce((sum, row) => sum + row.profit, 0)
    },
    months: rows
  };
}

registerTools([{
  name: 'finance.project',
  title: 'Project a business month by month',
  description: 'Projects customers, revenue, costs, profit and cash month by month for a business idea, with the break-even month, the customers needed to break even, and the funding needed. Use it for business ideas and plans; show the result as a table and say it is an estimate.',
  input: {
    months: '1-60 (default 12)', startingCash: 'money at the start', upfrontCost: 'one-off start-up cost',
    startingCustomers: 'customers at the start', newCustomersPerMonth: 'new customers in month 1', newCustomerGrowthPercent: 'monthly growth of new customers, %',
    monthlyChurnPercent: 'customers lost each month, %', pricePerCustomerPerMonth: 'revenue per customer per month',
    variableCostPerCustomerPerMonth: 'cost to serve one customer per month', fixedCostsPerMonth: 'rent, salaries, tools…'
  },
  ready: () => ({ ready: true }),
  run: input => projectBusiness(input)
}]);
