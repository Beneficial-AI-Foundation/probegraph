namespace Demo

/-- The successor. -/
def succ (n : Nat) : Nat :=
  n + 1

theorem succ_pos (n : Nat) : 0 < succ n := by
  simp [succ]

def twice (n : Nat) : Nat := succ (succ n)

end Demo
