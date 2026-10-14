import * as React from "react";
import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}

function THead(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="bg-slate-50" {...props} />;
}

function TH({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("px-3 py-2 text-left font-medium text-slate-600", className)}
      {...props}
    />
  );
}

function TD({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-t border-slate-100 px-3 py-2", className)} {...props} />;
}

export { Table, THead, TH, TD };
