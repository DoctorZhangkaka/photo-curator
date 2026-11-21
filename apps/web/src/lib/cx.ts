/** 轻量 className 合并，不引入额外依赖。 */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
