require('dotenv').config();
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
const { formatEther } = require('ethers/lib/utils');

// Supabase connection
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
        auth: {
            persistSession: false
        },
        db: {
            schema: 'public'
        }
    }
);

async function checkSupabaseConnection() {
    try {
        // Run a simple query to check if the connection is successful
        const { data, error } = await supabase
            .from('user_transactions')  // Query an existing table, e.g., 'user_transactions'
            .select('id')              // Just fetch one field from the table to test the connection
            .limit(1);                 // Limit to just one row to ensure it's a lightweight query

        if (error) {
            console.error('Error connecting to Supabase:', error.message);
        } else {
            console.log('Successfully connected to Supabase!');
        }
    } catch (err) {
        console.error('Error during Supabase connection check:', err.message);
    }
}

// Call this function when the app starts to verify the connection
checkSupabaseConnection();

// Contract ABI - Define only the events we need
const contractABI = [
    "event BoughtWithNative(address user, uint256 tokenDeposit, uint256 amount, uint256 timestamp)",
    "event BoughtWithUSDT(address user, uint256 tokenDeposit, uint256 amount, uint256 timestamp)",
    "event claimHistory(address _user, uint256 _amount, uint256 _timestamp)"
];

// Helper function to log transaction data in the `user_transactions` table
async function logTransactionToSupabase(eventName, user, tokenDeposit, amount, paymentType, transactionHash, blockNumber, blockTimestamp, chainName) {
    try {
        console.log("EVENTS LOGS:", eventName, user, tokenDeposit, amount, paymentType, transactionHash, blockNumber, blockTimestamp, chainName);
        
        // Add retry logic for network issues
        let retries = 3;
        while (retries > 0) {
            try {
                const { data, error } = await supabase
                    .from('user_transactions')
                    .insert([
                        {
                            address: user.toLowerCase(), // Convert address to lowercase
                            transaction_hash: transactionHash,
                            chain_name: chainName,
                            event_name: eventName,
                            payment_type: paymentType,
                            deposit_amount: tokenDeposit?.toString(),
                            token_amount: amount?.toString(),
                            block_number: blockNumber,
                            block_timestamp: blockTimestamp,
                        }
                    ]);

                if (error) throw error;
                console.log(`Transaction logged: ${eventName} for user ${user.toLowerCase()}`);
                break;
            } catch (err) {
                retries--;
                if (retries === 0) throw err;
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
            }
        }
    } catch (err) {
        console.error(`Error logging transaction: ${err.message}`);
    }
}

// Helper function to update or insert user deposit data in the `user_deposits` table
async function updateUserDeposit(address, depositAmount, tokenAmount, usdtAmount, paymentType) {
    try {
        // Convert amounts to numbers and handle potential NaN
        depositAmount = Number(depositAmount) || 0;
        tokenAmount = Number(tokenAmount) || 0;
        usdtAmount = Number(usdtAmount) || 0;
        
        // Convert address to lowercase
        const lowerAddress = address.toLowerCase();

        // First, try to get existing record
        const { data: existingDeposit } = await supabase
            .from('user_deposits')
            .select('*')
            .eq('address', lowerAddress)
            .single();

        let newData;
        if (existingDeposit) {
            // If record exists, update the values
            newData = {
                address: lowerAddress, // Include address in updates
                total_native_deposit: (Number(existingDeposit.total_native_deposit || 0) + (paymentType === 'native' ? depositAmount : 0)).toString(),
                total_usdt_deposit: (Number(existingDeposit.total_usdt_deposit || 0) + (paymentType === 'usdt' ? usdtAmount : 0)).toString(),
                total_token_amount: (Number(existingDeposit.total_token_amount || 0) + tokenAmount).toString(),
                last_updated: new Date().toISOString(),
            };
        } else {
            // If no record exists, create new data
            newData = {
                address: lowerAddress,
                total_native_deposit: paymentType === 'native' ? depositAmount.toString() : '0',
                total_usdt_deposit: paymentType === 'usdt' ? usdtAmount.toString() : '0',
                total_token_amount: tokenAmount.toString(),
                last_updated: new Date().toISOString(),
            };
        }

        const { error } = await supabase
            .from('user_deposits')
            .upsert(newData, {
                onConflict: 'address'
            });

        if (error) throw error;
        console.log(`User deposit updated for ${lowerAddress}`);
    } catch (err) {
        console.error('Error updating user deposit:', err);
        // Log full error details for debugging
        console.error('Full error:', JSON.stringify(err, null, 2));
    }
}

/////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////// FOR OLD EVENTS ///////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////

// // Function to query past events from the contract
// async function fetchPastEvents(provider, contract, eventName, fromBlock, toBlock) {
//     try {
//         const eventFilter = contract.filters[eventName]();
//         const events = await contract.queryFilter(eventFilter, fromBlock, toBlock);

//         for (let event of events) {
//             const { user, tokenDeposit, amount, timestamp } = event.args;
//             const { transactionHash, blockNumber } = event;
//             console.log(transactionHash, blockNumber,"transactionHash, blockNumber");
//             const blockTimestamp = new Date(timestamp * 1000); // Convert to JS Date object

//             console.log(`[${provider.network.name}] Past Event: ${eventName} detected: ${user} bought ${formatEther(amount?.toString())} tokens.`);
//             let tokens = provider.network.name == "bnbt" && eventName == "BoughtWithUSDT" ? formatEther(tokenDeposit?.toString()) : tokenDeposit?.toString() / 10**6
//             let desposit = eventName == "BoughtWithUSDT" ? tokens?.toString() : formatEther(tokenDeposit?.toString())
//             // Log the transaction to user_transactions table
//             await logTransactionToSupabase(eventName, user, desposit, formatEther(amount?.toString()), eventName, transactionHash?.toString(), blockNumber, blockTimestamp, provider.network.name);
//         }

//     } catch (err) {
//         console.error(`Error fetching past events: ${err.message}`);
//     }
// }



// Function to listen to events on a contract
async function listenToContractEvents(rpcUrl, contractAddress, networkName) {

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddress, contractABI, provider);

    // Fetch past events before starting live listeners
    // const blockNumber = await provider.getBlockNumber(); // Get latest block number

    // // Define the range of blocks to search for past events
    // const fromBlock = 48053650; // You can change this to the specific block number you want to start from
    // const toBlock = blockNumber;

    // // Fetch past events
    // await fetchPastEvents(provider, contract, 'BoughtWithNative', fromBlock, toBlock);
    // await fetchPastEvents(provider, contract, 'BoughtWithUSDT', fromBlock, toBlock);
    // await fetchPastEvents(provider, contract, 'claimHistory', fromBlock, toBlock);




    // Event listener for 'BoughtWithNative' event
    contract.on('BoughtWithNative', async (user, tokenDeposit, amount, timestamp, event) => {
        const blockTimestamp = new Date(timestamp * 1000);
        
        // Convert from wei to ETH/BNB/MATIC and format to 6 decimal places
        const depositInEth = Number(ethers.utils.formatEther(tokenDeposit));
        const amountInTokens = Number(ethers.utils.formatEther(amount));
        
        console.log(`[${networkName}] BoughtWithNative event:`, {
            user,
            deposit: depositInEth,
            tokens: amountInTokens
        });

        await logTransactionToSupabase(
            'BoughtWithNative',
            user,
            depositInEth.toFixed(6),
            amountInTokens.toFixed(6),
            'native',
            event?.transactionHash,
            event?.blockNumber,
            blockTimestamp,
            networkName
        );

        await updateUserDeposit(
            user,
            depositInEth.toFixed(6),
            amountInTokens.toFixed(6),
            0,
            'native'
        );
    });

    // Event listener for 'BoughtWithUSDT' event
    contract.on('BoughtWithUSDT', async (user, tokenDeposit, amount, timestamp, event) => {
        const blockTimestamp = new Date(timestamp * 1000);
        
        // Convert USDT amount (6 decimals) to normal number
        // const depositInUSDT = Number(tokenDeposit.toString()) / 1000000;
        const amountInTokens = Number(ethers.utils.formatEther(amount));
        
        let depositInUSDT = networkName == "BSC" ? Number(formatEther(tokenDeposit?.toString())) : Number(tokenDeposit?.toString() / 10 ** 6)


        console.log(`[${networkName}] BoughtWithUSDT event:`, {
            user,
            deposit: depositInUSDT,
            tokens: amountInTokens
        });

        await logTransactionToSupabase(
            'BoughtWithUSDT',
            user,
            depositInUSDT.toFixed(6),
            amountInTokens.toFixed(6),
            'usdt',
            event?.transactionHash,
            event?.blockNumber,
            blockTimestamp,
            networkName
        );

        await updateUserDeposit(
            user,
            0,
            amountInTokens.toFixed(6),
            depositInUSDT.toFixed(6),
            'usdt'
        );
    });

    // Event listener for 'claimHistory' event
    contract.on('claimHistory', async (_user, _amount, _timestamp, event) => {
        const blockTimestamp = new Date(_timestamp * 1000);
        const formattedAmount = Number(formatEther(_amount)).toFixed(6);
        
        console.log(`[${networkName}] claimHistory event detected: ${_user} claimed ${formattedAmount} tokens`);

        await logTransactionToSupabase(
            'claimHistory',
            _user,
            '0',
            formattedAmount,
            'claim',
            event?.transactionHash,
            event?.blockNumber,
            blockTimestamp,
            networkName
        );

        await updateUserDeposit(
            _user,
            0,
            formattedAmount,
            0,
            'token'
        );
    });

    console.log(`[${networkName}] Listening for events...`);
}

// Main function to start listeners for all networks
async function startListeners() {
    const networks = [
        {
            name: 'ETH',
            rpcUrl: process.env.ETH_RPC_URL,
            contractAddress: process.env.ETH_CONTRACT_ADDRESS
        },
        {
            name: 'BSC',
            rpcUrl: process.env.BSC_RPC_URL,
            contractAddress: process.env.BSC_CONTRACT_ADDRESS
        },
        {
            name: 'POLYGON',
            rpcUrl: process.env.POLYGON_RPC_URL,
            contractAddress: process.env.POLYGON_CONTRACT_ADDRESS
        }
    ];

    const listeners = networks.map((network) => {
        return listenToContractEvents(network.rpcUrl, network.contractAddress, network.name);
    });

    // Run all listeners in parallel
    await Promise.all(listeners);
    console.log('All event listeners are now active and listening in parallel...');
}

// Start listening for events from all networks
startListeners().catch((error) => {
    console.error('Error starting event listeners:', error);
});
