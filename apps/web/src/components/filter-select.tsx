'use client';

import * as RadixSelect from '@radix-ui/react-select';
import {Check, ChevronDown, ChevronUp} from 'lucide-react';

type Option = {value: number; label: string};

export default function FilterSelect({label,value,options,onChange,disabled=false}:{
  label:string;value:number;options:Option[];onChange:(value:number)=>void;disabled?:boolean;
}) {
  return <div className="filter-field">
    <span className="filter-label">{label}</span>
    <RadixSelect.Root value={String(value)} onValueChange={v=>onChange(Number(v))} disabled={disabled}>
      <RadixSelect.Trigger className="select-trigger" aria-label={label}>
        <RadixSelect.Value/><RadixSelect.Icon><ChevronDown size={16}/></RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="select-content" position="popper" sideOffset={7} collisionPadding={12}>
          <RadixSelect.ScrollUpButton className="select-scroll"><ChevronUp size={15}/></RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="select-viewport">
            {options.map(option=><RadixSelect.Item key={option.value} value={String(option.value)} className="select-option">
              <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              <RadixSelect.ItemIndicator className="select-check"><Check size={16}/></RadixSelect.ItemIndicator>
            </RadixSelect.Item>)}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="select-scroll"><ChevronDown size={15}/></RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  </div>;
}
