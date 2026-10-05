/** 目前選取的產業或股票，所有視圖與面板共用。 */
export type Focus = { kind: 'industry' | 'stock'; id: string } | null;

export function sameFocus(a: Focus, b: Focus): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}
