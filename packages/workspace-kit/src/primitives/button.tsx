import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const buttonVariants = cva(
	"group/button inline-flex shrink-0 items-center justify-center rounded-mdly-control text-[11px] font-medium whitespace-nowrap transition-[color,background-color,box-shadow,transform,opacity] duration-[var(--default-transition-duration)] ease-snappy outline-hidden select-none focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20 active:scale-[0.96] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-[3px] aria-invalid:ring-destructive/25 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:brightness-95",
				// Primary action in the mdly design system: ink fill (the Record
				// button look). `.mdly-ink-button` (apps/desktop index.css) supplies
				// radius, shadow, press scale and focus ring; hosts without it fall
				// back to the plain primary fill.
				ink: "mdly-ink-button bg-primary text-primary-foreground",
				// Secondary action: neutral control fill at the 14px control radius.
				soft: "bg-mdly-control text-foreground hover:bg-mdly-selected aria-expanded:bg-mdly-selected",
				outline:
					"bg-mdly-control text-foreground hover:bg-mdly-selected aria-expanded:bg-mdly-selected aria-expanded:text-foreground",
				secondary:
					"bg-secondary text-foreground hover:bg-muted aria-expanded:bg-muted aria-expanded:text-foreground",
				ghost:
					"text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
				destructive:
					"bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:ring-destructive/25 dark:bg-destructive/20 dark:hover:bg-destructive/30",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default:
					"h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				xs: "h-6 gap-1 px-2 text-[10px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-7 gap-1 px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
				icon: "size-8 rounded-full",
				"icon-xs": "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-7 rounded-full",
				"icon-lg": "size-9 rounded-full",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
