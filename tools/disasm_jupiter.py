"""Disassemble Jupiter v6 SBF bytecode and extract validation patterns."""
import struct, sys, json, re
from capstone import *
from elftools.elf.elffile import ELFFile

PROGRAM_PATH = r"C:\_Work\__EVM_AUDIT\targets\jupiter_v6_program.so"

# BPF instruction classes we care about
# Syscall numbers from Solana SDK
SOL_SYSCALLS = {
    0: "abort",
    1: "sol_log_",
    2: "sol_log_64_",
    3: "sol_log_pubkey",
    4: "sol_create_program_address",
    5: "sol_try_find_program_address",
    6: "sol_sha256",
    7: "sol_keccak256",
    8: "sol_secp256k1_recover",
    9: "sol_log_data",
    10: "sol_log_compute_units_",
    11: "sol_remaining_compute_units",
    12: "sol_alt_bn128_group_op",
    13: "sol_alt_bn128_compression",
    16: "sol_invoke_signed_c",
    17: "sol_invoke_signed_rust",
}

PROGRAMDATA_HEADER_SIZE = 45  # 8 bytes slot + 1 byte option + 32 bytes pubkey (+ padding)

def analyze():
    with open(PROGRAM_PATH, 'rb') as f:
        raw = f.read()
    # Strip Solana ProgramData account header
    elf_bytes = raw[PROGRAMDATA_HEADER_SIZE:]
    # Save stripped ELF
    elf_path = PROGRAM_PATH.replace('.so', '_elf.so')
    with open(elf_path, 'wb') as f:
        f.write(elf_bytes)
    print(f"Stripped ELF saved to {elf_path} ({len(elf_bytes)} bytes)")
    
    from io import BytesIO
    bio = BytesIO(elf_bytes)
    elf = ELFFile(bio)
    
    text_section = elf.get_section_by_name('.text')
    if not text_section:
        print("No .text section found")
        return
    
    text_data = text_section.data()
    text_addr = text_section['sh_addr']
    text_size = text_section['sh_size']
    
    print(f".text section: addr=0x{text_addr:x}, size={text_size}")
    
    md = Cs(CS_ARCH_BPF, CS_MODE_BPF_EXTENDED)
    md.detail = True
    md.syntax = CS_OPT_SYNTAX_NOREGNAME
    
    # Collect all syscall invocations for pattern analysis
    syscall_sites = []
    call_imm_sites = []  # call imm instructions (BPF_CALL with src=BPF_PSEUDO_CALL)
    exit_sites = []
    
    instructions = []
    for i, (addr, size, mnemonic, op_str) in enumerate(md.disasm_lite(text_data, text_addr)):
        instructions.append((addr, mnemonic, op_str))
        
        # Track syscalls
        if mnemonic == 'call' and op_str.startswith('0x'):
            imm = int(op_str, 16)
            if imm in SOL_SYSCALLS:
                syscall_sites.append((addr, imm, SOL_SYSCALLS[imm]))
        
        # Track direct calls
        if mnemonic == 'call' and not op_str.startswith('0x') and not op_str.startswith('r'):
            call_imm_sites.append((addr, op_str))
        
        # Track exit
        if mnemonic == 'exit':
            exit_sites.append(addr)
    
    print(f"\nTotal instructions: {len(instructions)}")
    print(f"Syscall invocations: {len(syscall_sites)}")
    print(f"Direct call sites: {len(call_imm_sites)}")
    print(f"Exit sites: {len(exit_sites)}")
    
    # Analyze syscall distribution
    print("\n--- Syscall distribution ---")
    syscall_counts = {}
    for addr, num, name in syscall_sites:
        syscall_counts[name] = syscall_counts.get(name, 0) + 1
    for name, count in sorted(syscall_counts.items(), key=lambda x: -x[1]):
        print(f"  {name}: {count}")
    
    # Look for CPI patterns (sol_invoke_signed_c / sol_invoke_signed_rust)
    # These indicate the program invokes other programs
    print("\n--- CPI (Cross-Program Invocation) sites ---")
    cpi_sites = [(a, n, nm) for a, n, nm in syscall_sites if 'invoke' in nm.lower()]
    for addr, num, name in cpi_sites:
        # Get a few instructions around the CPI for context
        context = []
        for inst_addr, mn, op in instructions:
            if abs(inst_addr - addr) <= 32:
                context.append(f"  0x{inst_addr:x}: {mn} {op}")
        print(f"\n  0x{addr:x}: syscall {name}")
        for line in context[-10:]:
            print(line)
    
    # Look for PDA derivation (sol_create_program_address / sol_try_find_program_address)
    print("\n--- PDA derivation sites ---")
    pda_sites = [(a, n, nm) for a, n, nm in syscall_sites if 'program_address' in nm.lower()]
    for addr, num, name in pda_sites:
        context = []
        for inst_addr, mn, op in instructions:
            if abs(inst_addr - addr) <= 40:
                context.append((inst_addr, mn, op))
        print(f"\n  0x{addr:x}: syscall {name}")
        # Show 8 instructions before
        before = [(a, m, o) for a, m, o in context if a <= addr][-8:]
        for a, m, o in before:
            print(f"  0x{a:x}: {m} {o}")
    
    # Extract string references
    print("\n--- String/seed references (.rodata) ---")
    rodata = elf.get_section_by_name('.rodata')
    if rodata:
        data = rodata.data()
        # Find printable ASCII sequences
        strings = []
        current = b''
        for b in data:
            if 32 <= b < 127:
                current += bytes([b])
            else:
                if len(current) >= 4:
                    strings.append(current.decode('ascii', errors='replace'))
                current = b''
        for s in strings[:50]:
            if any(kw in s.lower() for kw in ['authority', 'fee', 'claim', 'owner', 'token', 'account', 'signer', 'seed', 'mint', 'transfer', 'amount', 'route', 'swap', 'event', 'platform', 'referral']):
                print(f"  '{s}'")
    
    # Export syscall sites for further analysis
    print(f"\n--- Exported {len(syscall_sites)} syscall sites to syscalls.json ---")
    with open(r"C:\_Work\__EVM_AUDIT\targets\jupiter_syscalls.json", 'w') as f:
        json.dump([{"addr": hex(a), "num": n, "name": nm} for a, n, nm in syscall_sites], f, indent=2)
    
    # Check for specific patterns in first 500 instructions (entry point / dispatch)
    print("\n--- Entry point (first 120 instructions) ---")
    for addr, mn, op in instructions[:120]:
        marker = ""
        if mn == 'call' and op.startswith('0x'):
            imm = int(op, 16)
            if imm in SOL_SYSCALLS:
                marker = f"  ; {SOL_SYSCALLS[imm]}"
        print(f"  0x{addr:x}: {mn} {op}{marker}")

if __name__ == '__main__':
    analyze()
