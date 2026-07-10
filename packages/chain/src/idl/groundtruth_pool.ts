/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/groundtruth_pool.json`.
 */
export type GroundtruthPool = {
  "address": "B3XJrPdtvDRpnwNyk6s633WNrwJed2jJCKrE3Xuwn537",
  "metadata": {
    "name": "groundtruthPool",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Parimutuel prediction pools resolved by CPI into the TxLINE txoracle validate_stat proof check"
  },
  "instructions": [
    {
      "name": "claim",
      "docs": [
        "Pay out a position. Resolved: winners get stake + pro-rata share of the",
        "losing pool (if the winning pool is empty, everyone reclaims stake).",
        "Void: everyone reclaims stake."
      ],
      "discriminator": [
        62,
        198,
        214,
        193,
        213,
        159,
        108,
        210
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "market"
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "userToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "createMarket",
      "docs": [
        "Create a market for the given terms. Permissionless; the PDA is keyed",
        "by terms_hash, so a market for identical terms exists at most once."
      ],
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "terms"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdtMint",
          "address": "ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "terms",
          "type": {
            "defined": {
              "name": "marketTerms"
            }
          }
        },
        {
          "name": "lockTs",
          "type": "i64"
        },
        {
          "name": "resolveDeadlineTs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "deposit",
      "docs": [
        "Stake `amount` USDT on a side. Allowed while the market is Open and",
        "before lock_ts."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "userToken",
          "writable": true
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "sideYes",
          "type": "bool"
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "resolve",
      "docs": [
        "Resolve (or supersede a resolution of) the market with a Merkle proof.",
        "The proof is verified by the TxLINE oracle program against its posted",
        "daily scores root; this program only checks that the proven stats are",
        "the ones the market terms name, then records the outcome."
      ],
      "discriminator": [
        246,
        150,
        236,
        206,
        108,
        63,
        58,
        10
      ],
      "accounts": [
        {
          "name": "resolver",
          "signer": true
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "dailyScoresMerkleRoots",
          "docs": [
            "checks its own daily_scores_roots PDA / epoch alignment)."
          ]
        },
        {
          "name": "txoracleProgram",
          "address": "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
        }
      ],
      "args": [
        {
          "name": "ts",
          "type": "i64"
        },
        {
          "name": "fixtureSummary",
          "type": {
            "defined": {
              "name": "scoresBatchSummary"
            }
          }
        },
        {
          "name": "fixtureProof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        },
        {
          "name": "mainTreeProof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        },
        {
          "name": "statA",
          "type": {
            "defined": {
              "name": "statTerm"
            }
          }
        },
        {
          "name": "statB",
          "type": {
            "option": {
              "defined": {
                "name": "statTerm"
              }
            }
          }
        }
      ]
    },
    {
      "name": "voidMarket",
      "docs": [
        "Flip an unresolved market to Void once its resolve deadline passed",
        "(abandoned fixture, missing root, …). Permissionless."
      ],
      "discriminator": [
        243,
        175,
        46,
        124,
        95,
        101,
        39,
        69
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    }
  ],
  "events": [
    {
      "name": "claimed",
      "discriminator": [
        217,
        192,
        123,
        72,
        108,
        150,
        248,
        33
      ]
    },
    {
      "name": "marketResolved",
      "discriminator": [
        89,
        67,
        230,
        95,
        143,
        106,
        199,
        202
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "badTimeline",
      "msg": "lock_ts must precede resolve_deadline_ts"
    },
    {
      "code": 6001,
      "name": "marketNotOpen",
      "msg": "Market is not open"
    },
    {
      "code": 6002,
      "name": "marketLocked",
      "msg": "Market is locked for new positions"
    },
    {
      "code": 6003,
      "name": "marketNotLocked",
      "msg": "Market has not reached its lock time"
    },
    {
      "code": 6004,
      "name": "marketVoid",
      "msg": "Market is void"
    },
    {
      "code": 6005,
      "name": "marketNotResolved",
      "msg": "Market is not resolved"
    },
    {
      "code": 6006,
      "name": "zeroAmount",
      "msg": "Amount must be positive"
    },
    {
      "code": 6007,
      "name": "sideMismatch",
      "msg": "Position side does not match"
    },
    {
      "code": 6008,
      "name": "alreadyClaimed",
      "msg": "Position already claimed"
    },
    {
      "code": 6009,
      "name": "fixtureMismatch",
      "msg": "Proven fixture does not match market terms"
    },
    {
      "code": 6010,
      "name": "statMismatch",
      "msg": "Proven stat key/period does not match market terms"
    },
    {
      "code": 6011,
      "name": "evidenceTooEarly",
      "msg": "Evidence record predates market lock"
    },
    {
      "code": 6012,
      "name": "disputeWindowOpen",
      "msg": "Dispute window still open"
    },
    {
      "code": 6013,
      "name": "disputeWindowClosed",
      "msg": "Dispute window closed"
    },
    {
      "code": 6014,
      "name": "staleEvidence",
      "msg": "Evidence is not newer than current resolution"
    },
    {
      "code": 6015,
      "name": "deadlineNotReached",
      "msg": "Resolve deadline not reached"
    },
    {
      "code": 6016,
      "name": "noReturnData",
      "msg": "Oracle returned no data"
    },
    {
      "code": 6017,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6018,
      "name": "notYourPosition",
      "msg": "Position does not belong to caller"
    },
    {
      "code": 6019,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "binaryExpression",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "add"
          },
          {
            "name": "subtract"
          }
        ]
      }
    },
    {
      "name": "claimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "payout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "comparison",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "greaterThan"
          },
          {
            "name": "lessThan"
          },
          {
            "name": "equalTo"
          }
        ]
      }
    },
    {
      "name": "market",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "terms",
            "type": {
              "defined": {
                "name": "marketTerms"
              }
            }
          },
          {
            "name": "termsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lockTs",
            "type": "i64"
          },
          {
            "name": "resolveDeadlineTs",
            "type": "i64"
          },
          {
            "name": "yesPool",
            "type": "u64"
          },
          {
            "name": "noPool",
            "type": "u64"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "marketState"
              }
            }
          },
          {
            "name": "evidenceTs",
            "docs": [
              "ts (ms) of the scores record backing the current resolution."
            ],
            "type": "i64"
          },
          {
            "name": "disputeUntilTs",
            "type": "i64"
          },
          {
            "name": "winnerYes",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "winnerYes",
            "type": "bool"
          },
          {
            "name": "evidenceTs",
            "type": "i64"
          },
          {
            "name": "resolver",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "marketState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "resolved"
          },
          {
            "name": "void"
          }
        ]
      }
    },
    {
      "name": "marketTerms",
      "docs": [
        "Market terms — deliberately identical in layout to txoracle's",
        "MarketIntentParams so `hash()` equals the TxLINE terms_hash convention."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "period",
            "type": "u16"
          },
          {
            "name": "statAKey",
            "type": "u32"
          },
          {
            "name": "statBKey",
            "type": {
              "option": "u32"
            }
          },
          {
            "name": "predicate",
            "type": {
              "defined": {
                "name": "traderPredicate"
              }
            }
          },
          {
            "name": "op",
            "type": {
              "option": {
                "defined": {
                  "name": "binaryExpression"
                }
              }
            }
          },
          {
            "name": "negation",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "sideYes",
            "type": "bool"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "claimed",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "proofNode",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "hash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "isRightSibling",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "scoreStat",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "type": "u32"
          },
          {
            "name": "value",
            "type": "i32"
          },
          {
            "name": "period",
            "type": "i32"
          }
        ]
      }
    },
    {
      "name": "scoresBatchSummary",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "updateStats",
            "type": {
              "defined": {
                "name": "scoresUpdateStats"
              }
            }
          },
          {
            "name": "eventsSubTreeRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "scoresUpdateStats",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "updateCount",
            "type": "u32"
          },
          {
            "name": "minTimestamp",
            "type": "i64"
          },
          {
            "name": "maxTimestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "statTerm",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "statToProve",
            "type": {
              "defined": {
                "name": "scoreStat"
              }
            }
          },
          {
            "name": "eventStatRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "statProof",
            "type": {
              "vec": {
                "defined": {
                  "name": "proofNode"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "traderPredicate",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "threshold",
            "type": "i32"
          },
          {
            "name": "comparison",
            "type": {
              "defined": {
                "name": "comparison"
              }
            }
          }
        ]
      }
    }
  ]
};
