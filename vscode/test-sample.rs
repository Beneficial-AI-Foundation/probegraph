// Test file for Call Graph Visualizer extension

#[verifier::verify]
fn verified_add(a: u32, b: u32) -> u32 {
    a + b
}

fn main() {
    let result = calculate_sum(5, 3);
    println!("Result: {}", result);
    
    let verified = verified_add(10, 20);
    println!("Verified: {}", verified);
}

fn calculate_sum(x: i32, y: i32) -> i32 {
    let temp = helper_function(x);
    add_numbers(temp, y)
}

fn helper_function(n: i32) -> i32 {
    n * 2
}

fn add_numbers(a: i32, b: i32) -> i32 {
    a + b
}

pub fn public_api_function() {
    let data = process_data(vec![1, 2, 3]);
    internal_handler(data);
}

fn process_data(input: Vec<i32>) -> Vec<i32> {
    input.iter().map(|x| x * 2).collect()
}

fn internal_handler(data: Vec<i32>) {
    for item in data {
        println!("Processing: {}", item);
    }
}
