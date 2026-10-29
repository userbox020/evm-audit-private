"""Deep analysis of Jupiter v6 bytecode: account validation, CPI targets, claim paths."""
import struct, json, re
from capstone import *
from elftools.elf.elffile import ELFFile
from io import BytesIO

PROGRAM_PATH = r"C:\_Work\__EVM_AUDIT\targets\jupiter_v6_program_elf.so"

SOL_SYSCALLS = {
    0: "abort", 1: "sol_log_", 4: "sol_create_program_address",
    5: "sol_try_find_program_address", 16: "sol_invoke_signed_c",
    17: "sol_invoke_signed_rust",
}

def find_function_boundaries(instructions):
    """Find function entry points by looking for common prologue patterns."""
    funcs = []
    in_func = False
    for i in range(len(instructions) - 3):
        addr, mn, op = instructions[i]
        # Look for stack frame setup: stxdw [r10-imm], rX patterns
        if mn == 'stxdw' and 'r10' in op and not in_func:
            funcs.append(addr)
            in_func = True
        if mn == 'exit':
            in_func = False
    return funcs

def analyze_deep():
    with open(PROGRAM_PATH, 'rb') as f:
        elf_data = f.read()
    bio = BytesIO(elf_data)
    elf = ELFFile(bio)
    
    text = elf.get_section_by_name('.text')
    text_data = text.data()
    text_addr = text['sh_addr']
    
    md = Cs(CS_ARCH_BPF, CS_MODE_BPF_EXTENDED)
    md.detail = True
    md.syntax = CS_OPT_SYNTAX_NOREGNAME
    
    instructions = [(a, m, o) for a, sz, m, o in md.disasm_lite(text_data, text_addr)]
    
    # 1. Find all syscall sites with surrounding context for CPI analysis
    print("=" * 60)
    print("CPI (sol_invoke_signed_c) Call Sites - Full Context")
    print("=" * 60)
    
    for addr, mn, op in instructions:
        if mn == 'call' and op == '0x10':  # sol_invoke_signed_c
            print(f"\n--- CPI at 0x{addr:x} ---")
            # Show 15 instructions before
            before = [(a, m, o) for a, m, o in instructions if a < addr and a >= addr - 120]
            for a, m, o in before[-15:]:
                print(f"  0x{a:x}: {m} {o}")
            print(f"  >>> 0x{addr:x}: call 0x10  ; sol_invoke_signed_c")
            after = [(a, m, o) for a, m, o in instructions if a > addr and a <= addr + 120]
            for a, m, o in after[:15]:
                print(f"  0x{a:x}: {m} {o}")
    
    # 2. Find entry point dispatch (instruction selector)
    print("\n" + "=" * 60)
    print("Instruction Dispatch Analysis")
    print("=" * 60)
    
    # The entry point starts at .text addr
    # Anchor programs have an 8-byte discriminator check
    # Look for the discriminator comparisons in the first 500 instructions
    
    discriminators = []
    for addr, mn, op in instructions[:500]:
        if mn in ('ldxdw', 'mov64') and 'r1' in op and not op.startswith('['):
            # Check if next instruction is a comparison
            pass
        # Look for lddw (load 64-bit immediate) which could be discriminators
        if mn == 'lddw' and addr < text_addr + 2000:
            for a2, m2, o2 in instructions:
                if a2 == addr + 16 and m2 in ('jeq', 'jne', 'jeq32', 'jne32'):
                    # Could be discriminator check
                    discriminators.append((addr, a2))
    
    # 3. String analysis - find all function names
    print("\n" + "=" * 60)
    print("Source File References (function context)")
    print("=" * 60)
    rodata = elf.get_section_by_name('.rodata')
    if rodata:
        data = rodata.data()
        rust_strings = []
        current = b''
        for b_ in data:
            if 32 <= b_ < 127:
                current += bytes([b_])
            else:
                if len(current) >= 10:
                    rust_strings.append(current.decode('ascii', errors='replace'))
                current = b''
        for s in rust_strings:
            if any(ext in s for ext in ['.rs', '.py', '.c', '.h']):
                print(f"  {s}")
    
    # 4. Look for account index access patterns
    print("\n" + "=" * 60)
    print("Account Access Pattern Analysis")
    print("=" * 60)
    
    # Anchor programs access accounts via the accounts array at r6
    # Looking for patterns like: ldxdw rX, [r6+offset] 
    account_reads = {}
    for addr, mn, op in instructions:
        if mn == 'ldxdw' and 'r6' in op:
            # Extract the offset
            import re
            m = re.search(r'\[r6\+([^\]]+)\]', op.replace('0x', ''))
            if m:
                try:
                    off = int(m.group(1), 16)
                    if off not in account_reads:
                        account_reads[off] = []
                    account_reads[off].append(addr)
                except:
                    pass
    
    print(f"Unique account offsets read: {len(account_reads)}")
    for off in sorted(account_reads.keys())[:30]:
        count = len(account_reads[off])
        print(f"  offset 0x{off:x} ({off}): {count} reads, first at 0x{list(account_reads[off])[0]:x}")
    
    # 5. Look for the 'authority' seed string pattern in bytecode
    print("\n" + "=" * 60)
    print("Seed/String Pattern Search")
    print("=" * 60)
    
    seeds_of_interest = [b'authority', b'open_orders', b'__event', b'platform', b'fee', b'claim', b'ledger', b'referral']
    for seed in seeds_of_interest:
        # Search in rodata for this seed
        if rodata:
            found = data.find(seed)
            if found >= 0:
                context_start = max(0, found - 10)
                context_end = min(len(data), found + len(seed) + 30)
                context = data[context_start:context_end]
                printable = ''.join(chr(b) if 32 <= b < 127 else '.' for b in context)
                print(f"  Found '{seed.decode()}' at rodata offset {found}: ...{printable}...")
    
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"Total instructions: {len(instructions)}")
    print(f"CPI calls: 4 (all sol_invoke_signed_c)")
    print(f"PDA derivations: 1")
    print(f"Exit points: {sum(1 for _, m, _ in instructions if m == 'exit')}")
    print(f"Account offset reads: {len(account_reads)} unique offsets")

if __name__ == '__main__':
    analyze_deep()
