import { Table, THead, TH, TD } from "@/components/ui/table";

/** Minimal read-only table for bounded server-rendered lists. */
export function SimpleTable({
  columns,
  rows,
  empty,
  caption,
}: {
  columns: string[];
  rows: (string | React.ReactNode)[][];
  empty: string;
  caption?: string;
}) {
  return (
    <div className="space-y-2">
      <Table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <THead>
          <tr>
            {columns.map((c) => (
              <TH key={c} scope="col">
                {c}
              </TH>
            ))}
          </tr>
        </THead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <TD colSpan={columns.length} className="py-8 text-center text-slate-500">
                {empty}
              </TD>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <TD key={j}>{cell}</TD>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </Table>
      <p className="text-xs text-slate-500">
        {rows.length} row{rows.length === 1 ? "" : "s"} shown (bounded server query).
      </p>
    </div>
  );
}
