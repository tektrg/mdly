import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				"h-8 w-full min-w-0 rounded-full bg-mdly-control px-3 py-1 text-[11px] transition-[color,background-color,box-shadow] duration-[var(--default-transition-duration)] ease-snappy outline-hidden file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-[11px] file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-mdly-ink/10 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[3px] aria-invalid:ring-destructive/25",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
