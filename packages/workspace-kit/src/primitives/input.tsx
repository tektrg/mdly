import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "../lib/utils";

type InputProps = React.ComponentProps<"input"> & {
	variant?: "default" | "ghost";
};

function Input({ className, type, variant = "default", ...props }: InputProps) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				"h-8 w-full min-w-0 rounded-full ps-3 pe-3 py-1 text-[11px] transition-[color,background-color,box-shadow] duration-[var(--default-transition-duration)] ease-snappy outline-hidden file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-[11px] file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
				variant === "ghost"
					? "bg-transparent shadow-none inset-shadow-none focus-visible:bg-transparent focus-visible:ring-0 aria-invalid:ring-[3px] aria-invalid:ring-destructive/25"
					: "bg-mdly-control focus-visible:ring-[3px] focus-visible:ring-mdly-ink/10 disabled:opacity-50 aria-invalid:ring-[3px] aria-invalid:ring-destructive/25",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
