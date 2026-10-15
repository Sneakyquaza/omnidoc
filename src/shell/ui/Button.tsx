import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import styles from "./Button.module.css";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  icon?: IconName;
  children?: ReactNode;
}

export function Button({ variant = "secondary", icon, children, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`${styles.button} ${styles[variant]} ${className ?? ""}`}
      {...rest}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** Libellé accessible + infobulle (déjà traduit). */
  label: string;
  pressed?: boolean;
}

export function IconButton({ icon, label, pressed, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`${styles.button} ${styles.ghost} ${styles.icon} ${className ?? ""}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}
