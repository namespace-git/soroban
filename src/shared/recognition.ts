import type { SaleProfit, SaleTotals } from './types'

/** 取引完了と、完了済みとして手入力された状態未設定の販売を実績とする。 */
export function isRealized(sale: Pick<SaleProfit, 'status' | 'source'>): boolean {
  return sale.status === 'completed' || (sale.source === 'manual' && sale.status == null)
}

export function forecastTotals(sales: SaleProfit[]) {
  return sales.filter(s => !isRealized(s)).reduce((sum, s) => ({
    count: sum.count + 1,
    revenue: sum.revenue + s.price,
    gross_profit: sum.gross_profit + s.gross_profit,
  }), { count: 0, revenue: 0, gross_profit: 0 })
}

export function realizedTotals(sales: SaleProfit[]): SaleTotals {
  return {
    ...sales.filter(isRealized).reduce((acc, s) => ({
      count: acc.count + 1, revenue: acc.revenue + s.price,
      total_fee: acc.total_fee + s.fee, total_shipping: acc.total_shipping + s.shipping_fee,
      total_packaging: acc.total_packaging + s.packaging_cost,
      total_cost: acc.total_cost + s.cost, gross_profit: acc.gross_profit + s.gross_profit,
    }), { count: 0, revenue: 0, total_fee: 0, total_shipping: 0, total_packaging: 0, total_cost: 0, gross_profit: 0 }),
    forecast: forecastTotals(sales),
  }
}
