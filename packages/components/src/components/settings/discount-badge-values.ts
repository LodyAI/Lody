export function discountBadgeValues(discountPercent: number) {
  return {
    discount: discountPercent,
    rate: (100 - discountPercent) / 10,
  };
}
