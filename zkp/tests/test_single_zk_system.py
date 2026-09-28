"""
Single Comprehensive Test for the ONE ZK System
Tests only the 4 classes that actually exist in zk_system.py
"""

import asyncio
import pytest
import tempfile
from pathlib import Path

from zkp.core.zk_system import (
    AuthenticZKStark,
    AuthenticProofManager,
    AuthenticFiniteField,
    AuthenticMerkleTree
)


class TestSingleZKSystem:
    """Test the single comprehensive ZK implementation"""
    
    def setup_method(self):
        self.temp_dir = tempfile.mkdtemp()
        self.zk_system = AuthenticZKStark()
        self.proof_manager = AuthenticProofManager(self.temp_dir)
        self.field = AuthenticFiniteField(2**127 - 1)
    
    def test_finite_field_operations(self):
        """Test finite field arithmetic"""
        # Test basic operations
        assert self.field.add(5, 3) == 8
        assert self.field.mul(4, 6) == 24
        assert self.field.sub(10, 4) == 6
        
        # Test modular arithmetic
        large_a = self.field.prime - 1
        large_b = 5
        result = self.field.add(large_a, large_b)
        assert result == 4  # Should wrap around
    
    def test_merkle_tree(self):
        """Test Merkle tree construction"""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = AuthenticMerkleTree(leaves)
        
        # Should have a root
        assert tree.root is not None
        assert len(tree.root) == 32  # SHA256 hash length
        
        # Empty tree should work
        empty_tree = AuthenticMerkleTree([])
        assert empty_tree.root == b''
    
    @pytest.mark.asyncio
    async def test_zk_proof_generation(self):
        """Proof generation + verification against the CUDATrueSTARK shape.

        Rewritten 2026-09-28: the old assertions targeted the pre-cutover
        sigma-protocol shape (commitment/challenge/response) and awaited a
        sync method. CUDATrueSTARK (c56ff363) is sync with an async wrapper
        and emits the STARK proof shape (trace root, FRI layers, queries).
        """
        statement = {
            "public_input": 42,
            "computation": "square"
        }
        witness = {
            "secret": 42,
            "intermediate": 42 * 42
        }

        proof = await self.zk_system.generate_proof_async(statement, witness)

        # Current STARK proof structure
        assert isinstance(proof, dict)
        for key in (
            "statement_hash",
            "trace_merkle_root",
            "fri_roots",
            "query_responses",
            "field_prime",
            "timestamp",
            "grinding_nonce",
        ):
            assert key in proof, f"missing proof field: {key}"
        assert isinstance(proof["cuda_accelerated"], bool)

        # Round-trip verification
        assert self.zk_system.verify_proof(proof, statement) is True

        # Binding: a different statement must NOT verify
        assert self.zk_system.verify_proof(
            proof, {"public_input": 43, "computation": "square"}
        ) is False

    @pytest.mark.asyncio
    async def test_proof_manager(self):
        """Disk-backed persistence: create → get → verify → delete."""
        statement = {"value": 100}
        witness = {"secret": 10}

        record = await self.proof_manager.create_proof("t-proof-1", statement, witness)
        assert record["status"] == "valid"
        assert record["proof_id"] == "t-proof-1"

        stored = self.proof_manager.get_proof("t-proof-1")
        assert stored is not None
        assert stored["statement"] == statement

        assert self.proof_manager.verify_proof_sync("t-proof-1") is True
        assert "t-proof-1" in self.proof_manager.list_proofs()
        assert self.proof_manager.delete_proof("t-proof-1") is True
        assert self.proof_manager.verify_proof_sync("t-proof-1") is False

    @pytest.mark.asyncio
    async def test_multiple_proofs(self):
        """Several independent proofs all verify against their own statements."""
        proofs = []

        for i in range(3):
            statement = {"iteration": i}
            witness = {"secret_value": i * 2}
            proof = await self.zk_system.generate_proof_async(statement, witness)
            proofs.append((proof, statement))

        for proof, statement in proofs:
            assert self.zk_system.verify_proof(proof, statement)
    
    def test_system_consistency(self):
        """Test system consistency across operations"""
        # Test field consistency
        a, b, c = 123, 456, 789
        result1 = self.field.add(self.field.mul(a, b), c)
        result2 = self.field.add(c, self.field.mul(a, b))
        assert result1 == result2  # Commutativity
        
        # Test Merkle tree consistency
        data = [b"consistent", b"data", b"test"]
        tree1 = AuthenticMerkleTree(data)
        tree2 = AuthenticMerkleTree(data)
        assert tree1.root == tree2.root  # Same input = same root


if __name__ == "__main__":
    # Simple test runner for direct execution
    import sys
    
    print("🧪 TESTING SINGLE ZK SYSTEM")
    print("=" * 40)
    
    test_instance = TestSingleZKSystem()
    test_instance.setup_method()
    
    try:
        # Test finite field
        print("✅ Testing finite field operations...")
        test_instance.test_finite_field_operations()
        
        # Test Merkle tree
        print("✅ Testing Merkle tree...")
        test_instance.test_merkle_tree()
        
        # Test ZK proofs
        print("✅ Testing ZK proof generation...")
        asyncio.run(test_instance.test_zk_proof_generation())
        
        # Test proof manager
        print("✅ Testing proof manager...")
        asyncio.run(test_instance.test_proof_manager())
        
        # Test multiple proofs
        print("✅ Testing multiple proofs...")
        asyncio.run(test_instance.test_multiple_proofs())
        
        # Test consistency
        print("✅ Testing system consistency...")
        test_instance.test_system_consistency()
        
        print("\n🎉 ALL TESTS PASSED!")
        print("💯 Single ZK system is fully functional")
        
    except Exception as e:
        print(f"\n❌ TEST FAILED: {e}")
        sys.exit(1)
