/**
 * Server-side financial column resolver.
 *
 * TMS exports vary in column name casing and wording across systems and users.
 * This module resolves the ACTUAL column name from whatever headers are present
 * in the uploaded rows, using case-insensitive regex matching — exactly the
 * same strategy as the client-side colMap in financials.tsx.
 *
 * Usage:
 *   import { resolveColumns } from "./colResolver";
 *   const cols = resolveColumns(rows);          // call once per batch
 *   const customer = row[cols.customer];         // use throughout
 */

export interface FinancialCols {
  totalCharges: string;
  freightCharge: string;
  customer: string;
  opsUser: string;
  dispatcher: string;
  salesperson: string;
  orderType: string;
  status: string;
  shipperCity: string;
  shipperState: string;
  consigneeCity: string;
  consigneeState: string;
  dateOrdered: string;
  orderNumber: string;
  rate: string;
  revenue: string;
  destination: string;
  destinationState: string;
  origin: string;
  originState: string;
  week: string;
  deliveryDate: string;
  marginDollar: string;
  tenderMethod: string;
}

export function resolveColumns(rows: any[]): FinancialCols {
  const keys = rows.length > 0 ? Object.keys(rows[0]) : [];
  const find = (p: RegExp, fb: string): string => keys.find(k => p.test(k)) ?? fb;
  return {
    totalCharges:     find(/total.?charges?|total.?revenue/i,                          "Total charges"),
    freightCharge:    find(/freight.?charge|carrier.?cost|linehaul|^freight$/i,         "Freight charge"),
    customer:         find(/customer/i,                                                 "Customer"),
    opsUser:          find(/operations?.?user|ops?.?user/i,                             "Operations user"),
    dispatcher:       find(/^dispatcher$/i,                                             "Dispatcher"),
    salesperson:      find(/^salesperson$|^sales.?person$|^sales.?rep$|^salesman$/i,   "Salesperson"),
    orderType:        find(/order.?type|load.?type|movement.?type/i,                   "Order type"),
    status:           find(/^status$/i,                                                 "Status"),
    shipperCity:      find(/shipper.?city|origin.?city|pickup.?city|^origin$/i,         "Shipper city"),
    shipperState:     find(/shipper.?state|origin.?state|pickup.?state/i,               "Shipper state"),
    consigneeCity:    find(/consignee.?city|dest.?city|delivery.?city|^destination$/i,  "Consignee city"),
    consigneeState:   find(/consignee.?state|dest.?state|delivery.?state|destination.?state/i, "Consignee state"),
    dateOrdered:      find(/date.?ordered|order.?date|ship.?date|delivery.?date/i,      "Date ordered"),
    orderNumber:      find(/order.?number|load.?number|shipment.?id|^order$/i,          "Order number"),
    rate:             find(/^rate$|^price$/i,                                           "Rate"),
    revenue:          find(/total.?revenue|^revenue$/i,                                 "Total revenue"),
    destination:      find(/^destination$/i,                                            "Destination"),
    destinationState: find(/destination.?state/i,                                       "Destination state"),
    origin:           find(/^origin$/i,                                                 "Origin"),
    originState:      find(/origin.?state/i,                                            "Origin state"),
    week:             find(/^week$/i,                                                   "Week"),
    deliveryDate:     find(/delivery.?date/i,                                           "Delivery date"),
    marginDollar:     find(/margin.?\$|^margin$/i,                                      "Margin $"),
    tenderMethod:     find(/tender/i,                                                   "Tender Method"),
  };
}

/** Extract the ops rep value from a row using resolved cols. */
export function getRepFromRow(row: any, cols: FinancialCols): string {
  return String(row[cols.opsUser] || "").trim().toLowerCase();
}

/** Extract the dispatcher name from a row using resolved cols. */
export function getDispatcherFromRow(row: any, cols: FinancialCols): string {
  return String(row[cols.dispatcher] || row["Dispatcher"] || "").trim();
}

/** Extract the salesperson name from a row using resolved cols. */
export function getSalespersonFromRow(row: any, cols: FinancialCols): string {
  return String(row[cols.salesperson] || row["Salesperson"] || "").trim();
}

/** Extract status from a row using resolved cols. */
export function getStatusFromRow(row: any, cols: FinancialCols): string {
  return String(row[cols.status] || "").toLowerCase();
}

/** Extract customer name from a row using resolved cols. */
export function getCustomerFromRow(row: any, cols: FinancialCols): string {
  return String(row[cols.customer] || "").trim();
}
